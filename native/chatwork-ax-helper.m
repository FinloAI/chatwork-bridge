#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

static const NSInteger kDefaultMaxElements = 500;
static const NSInteger kDefaultMaxDepth = 10;
static const NSInteger kDefaultMaxValueLength = 1000;

static int WriteJSON(NSDictionary *object, FILE *stream, int exitCode) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
    if (data == nil) {
        NSString *fallback = @"{\"ok\":false,\"error\":{\"code\":\"JSON_ENCODING_FAILED\",\"message\":\"Unable to encode helper response.\"}}\n";
        fwrite(fallback.UTF8String, 1, strlen(fallback.UTF8String), stderr);
        return 70;
    }
    fwrite(data.bytes, 1, data.length, stream);
    fwrite("\n", 1, 1, stream);
    fflush(stream);
    return exitCode;
}

static int Fail(NSString *code, NSString *message, NSString *hint) {
    NSMutableDictionary *error = [@{
        @"code": code ?: @"UNKNOWN_ERROR",
        @"message": message ?: @"The accessibility helper failed."
    } mutableCopy];
    if (hint.length > 0) error[@"hint"] = hint;
    return WriteJSON(@{ @"ok": @NO, @"error": error }, stderr, 1);
}

static NSString *AXErrorName(AXError error) {
    switch (error) {
        case kAXErrorSuccess: return @"success";
        case kAXErrorFailure: return @"failure";
        case kAXErrorIllegalArgument: return @"illegal_argument";
        case kAXErrorInvalidUIElement: return @"invalid_ui_element";
        case kAXErrorInvalidUIElementObserver: return @"invalid_ui_element_observer";
        case kAXErrorCannotComplete: return @"cannot_complete";
        case kAXErrorAttributeUnsupported: return @"attribute_unsupported";
        case kAXErrorActionUnsupported: return @"action_unsupported";
        case kAXErrorNotificationUnsupported: return @"notification_unsupported";
        case kAXErrorNotImplemented: return @"not_implemented";
        case kAXErrorNotificationAlreadyRegistered: return @"notification_already_registered";
        case kAXErrorNotificationNotRegistered: return @"notification_not_registered";
        case kAXErrorAPIDisabled: return @"api_disabled";
        case kAXErrorNoValue: return @"no_value";
        case kAXErrorParameterizedAttributeUnsupported: return @"parameterized_attribute_unsupported";
        case kAXErrorNotEnoughPrecision: return @"not_enough_precision";
    }
    return [NSString stringWithFormat:@"ax_error_%d", (int)error];
}

static NSDictionary *FrontmostApplicationInfo(void) {
    NSRunningApplication *application = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (application == nil || application.processIdentifier <= 0) return nil;
    return @{
        @"pid": @(application.processIdentifier),
        @"name": application.localizedName ?: @"",
        @"bundleIdentifier": application.bundleIdentifier ?: [NSNull null]
    };
}

static NSString *ISO8601Now(void) {
    static NSISO8601DateFormatter *formatter;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        formatter = [[NSISO8601DateFormatter alloc] init];
        formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime |
                                  NSISO8601DateFormatWithFractionalSeconds;
    });
    return [formatter stringFromDate:[NSDate date]];
}

static id CopyAttribute(AXUIElementRef element, CFStringRef attribute, AXError *errorOut) {
    CFTypeRef value = NULL;
    AXError error = AXUIElementCopyAttributeValue(element, attribute, &value);
    if (errorOut != NULL) *errorOut = error;
    if (error != kAXErrorSuccess || value == NULL) {
        if (value != NULL) CFRelease(value);
        return nil;
    }
    return CFBridgingRelease(value);
}

static NSString *StringAttribute(AXUIElementRef element, CFStringRef attribute) {
    id value = CopyAttribute(element, attribute, NULL);
    if ([value isKindOfClass:NSString.class]) return value;
    if ([value isKindOfClass:NSAttributedString.class]) return [(NSAttributedString *)value string];
    return nil;
}

static id BooleanAttribute(AXUIElementRef element, CFStringRef attribute) {
    id value = CopyAttribute(element, attribute, NULL);
    if ([value isKindOfClass:NSNumber.class]) return value;
    return [NSNull null];
}

static NSString *TruncateString(NSString *value, NSInteger maximumLength) {
    if (value == nil) return nil;
    if (maximumLength < 0 || value.length <= (NSUInteger)maximumLength) return value;
    if (maximumLength == 0) return @"";
    NSRange requested = NSMakeRange(0, (NSUInteger)maximumLength);
    NSRange safe = [value rangeOfComposedCharacterSequencesForRange:requested];
    if (NSMaxRange(safe) > (NSUInteger)maximumLength) {
        safe = [value rangeOfComposedCharacterSequenceAtIndex:(NSUInteger)maximumLength - 1];
        safe = NSMakeRange(0, safe.location);
    }
    return [[value substringWithRange:safe] stringByAppendingString:@"…"];
}

static NSString *TextFromValue(id value) {
    if ([value isKindOfClass:NSString.class]) return value;
    if ([value isKindOfClass:NSAttributedString.class]) return [(NSAttributedString *)value string];
    if ([value isKindOfClass:NSNumber.class]) return [(NSNumber *)value stringValue];
    if ([value isKindOfClass:NSURL.class]) return [(NSURL *)value absoluteString];
    if ([value isKindOfClass:NSDate.class]) return [(NSDate *)value description];
    return nil;
}

static BOOL ContainsSensitiveLabel(NSString *value) {
    if (value.length == 0) return NO;
    NSString *lower = value.lowercaseString;
    NSArray<NSString *> *terms = @[
        @"password", @"passcode", @"passwd", @"pin code", @"security code",
        @"verification code", @"one-time", @"one time", @"otp", @"2fa",
        @"token", @"secret", @"api key", @"credential", @"credit card", @"cvv",
        @"密码", @"口令", @"验证码", @"密钥", @"令牌", @"银行卡", @"信用卡", @"安全码"
    ];
    for (NSString *term in terms) {
        if ([lower rangeOfString:term].location != NSNotFound) return YES;
    }
    return NO;
}

static BOOL IsSensitiveElement(NSString *role, NSString *subrole, NSString *title,
                               NSString *description) {
    if ([role isEqualToString:@"AXSecureTextField"] ||
        [subrole isEqualToString:(__bridge NSString *)kAXSecureTextFieldSubrole]) {
        return YES;
    }
    return ContainsSensitiveLabel(title) || ContainsSensitiveLabel(description);
}

static NSDictionary *BoundsForElement(AXUIElementRef element) {
    id positionObject = CopyAttribute(element, kAXPositionAttribute, NULL);
    id sizeObject = CopyAttribute(element, kAXSizeAttribute, NULL);
    if (positionObject == nil || sizeObject == nil ||
        CFGetTypeID((__bridge CFTypeRef)positionObject) != AXValueGetTypeID() ||
        CFGetTypeID((__bridge CFTypeRef)sizeObject) != AXValueGetTypeID()) {
        return nil;
    }

    AXValueRef positionValue = (__bridge AXValueRef)positionObject;
    AXValueRef sizeValue = (__bridge AXValueRef)sizeObject;
    CGPoint position = CGPointZero;
    CGSize size = CGSizeZero;
    if (AXValueGetType(positionValue) != kAXValueCGPointType ||
        AXValueGetType(sizeValue) != kAXValueCGSizeType ||
        !AXValueGetValue(positionValue, kAXValueCGPointType, &position) ||
        !AXValueGetValue(sizeValue, kAXValueCGSizeType, &size)) {
        return nil;
    }
    return @{
        @"x": @(position.x),
        @"y": @(position.y),
        @"width": @(size.width),
        @"height": @(size.height)
    };
}

static NSArray<NSString *> *ActionsForElement(AXUIElementRef element) {
    CFArrayRef actionNames = NULL;
    AXError error = AXUIElementCopyActionNames(element, &actionNames);
    if (error != kAXErrorSuccess || actionNames == NULL) {
        if (actionNames != NULL) CFRelease(actionNames);
        return @[];
    }
    NSArray *values = CFBridgingRelease(actionNames);
    NSMutableArray<NSString *> *result = [NSMutableArray arrayWithCapacity:values.count];
    for (id value in values) {
        if ([value isKindOfClass:NSString.class]) [result addObject:value];
    }
    return result;
}

static NSArray *CopyChildrenBounded(AXUIElementRef element, NSUInteger maximumCount,
                                    BOOL *limitedOut, AXError *errorOut) {
    CFIndex count = 0;
    AXError error = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute, &count);
    if (errorOut != NULL) *errorOut = error;
    if (limitedOut != NULL) *limitedOut = NO;
    if (error != kAXErrorSuccess || count <= 0) return nil;

    CFIndex requested = (CFIndex)MIN((NSUInteger)count, maximumCount);
    if (limitedOut != NULL) *limitedOut = requested < count;
    if (requested == 0) return @[];

    CFArrayRef values = NULL;
    error = AXUIElementCopyAttributeValues(element, kAXChildrenAttribute, 0, requested, &values);
    if (errorOut != NULL) *errorOut = error;
    if (error != kAXErrorSuccess || values == NULL) {
        if (values != NULL) CFRelease(values);
        return nil;
    }
    id children = CFBridgingRelease(values);
    return [children isKindOfClass:NSArray.class] ? children : nil;
}

static id CopyChildAtIndex(AXUIElementRef element, NSUInteger index, AXError *errorOut) {
    CFIndex count = 0;
    AXError error = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute, &count);
    if (errorOut != NULL) *errorOut = error;
    if (error != kAXErrorSuccess || index >= (NSUInteger)MAX(0, count)) return nil;

    CFArrayRef values = NULL;
    error = AXUIElementCopyAttributeValues(element, kAXChildrenAttribute, (CFIndex)index, 1, &values);
    if (errorOut != NULL) *errorOut = error;
    if (error != kAXErrorSuccess || values == NULL) {
        if (values != NULL) CFRelease(values);
        return nil;
    }
    NSArray *children = CFBridgingRelease(values);
    return children.count == 1 ? children.firstObject : nil;
}

static NSDictionary *DescribeElement(AXUIElementRef element, NSString *path,
                                     NSInteger maximumValueLength) {
    NSString *role = StringAttribute(element, kAXRoleAttribute);
    NSString *subrole = StringAttribute(element, kAXSubroleAttribute);
    NSString *title = StringAttribute(element, kAXTitleAttribute);
    NSString *description = StringAttribute(element, kAXDescriptionAttribute);
    NSString *value = nil;
    BOOL sensitive = IsSensitiveElement(role, subrole, title, description);
    if (sensitive) {
        value = @"[REDACTED]";
    } else {
        value = TruncateString(TextFromValue(CopyAttribute(element, kAXValueAttribute, NULL)),
                               maximumValueLength);
    }

    return @{
        @"path": path,
        @"role": role ?: [NSNull null],
        @"subrole": subrole ?: [NSNull null],
        @"title": title ?: [NSNull null],
        @"description": description ?: [NSNull null],
        @"value": value ?: [NSNull null],
        @"valueRedacted": @(sensitive),
        @"bounds": BoundsForElement(element) ?: [NSNull null],
        @"actions": ActionsForElement(element),
        @"enabled": BooleanAttribute(element, kAXEnabledAttribute),
        @"focused": BooleanAttribute(element, kAXFocusedAttribute)
    };
}

static BOOL ParseInteger(NSString *raw, NSInteger minimum, NSInteger maximum, NSInteger *result) {
    if (raw.length == 0) return NO;
    NSScanner *scanner = [NSScanner scannerWithString:raw];
    long long value = 0;
    if (![scanner scanLongLong:&value] || !scanner.isAtEnd || value < minimum || value > maximum) {
        return NO;
    }
    if (result != NULL) *result = (NSInteger)value;
    return YES;
}

static NSDictionary<NSString *, NSString *> *ParseOptions(NSArray<NSString *> *arguments,
                                                           NSSet<NSString *> *allowed,
                                                           NSString **errorMessage) {
    NSMutableDictionary<NSString *, NSString *> *options = [NSMutableDictionary dictionary];
    for (NSUInteger index = 0; index < arguments.count; index += 2) {
        NSString *key = arguments[index];
        if (![key hasPrefix:@"--"] || ![allowed containsObject:key]) {
            if (errorMessage != NULL) *errorMessage = [NSString stringWithFormat:@"Unknown option: %@", key];
            return nil;
        }
        if (index + 1 >= arguments.count) {
            if (errorMessage != NULL) *errorMessage = [NSString stringWithFormat:@"Missing value for %@.", key];
            return nil;
        }
        if (options[key] != nil) {
            if (errorMessage != NULL) *errorMessage = [NSString stringWithFormat:@"Option %@ may only be supplied once.", key];
            return nil;
        }
        options[key] = arguments[index + 1];
    }
    return options;
}

static int RequireAccessibilityPermission(void) {
    if (AXIsProcessTrusted()) return 0;
    return Fail(@"ACCESSIBILITY_PERMISSION_DENIED",
                @"Accessibility access is required to inspect or operate application UI.",
                @"Grant Accessibility access to the bridge process in System Settings > Privacy & Security > Accessibility, then retry.");
}

static int RunActiveApp(NSArray<NSString *> *arguments) {
    if (arguments.count != 0) {
        return Fail(@"INVALID_ARGUMENT", @"active-app does not accept options.", nil);
    }
    NSDictionary *application = FrontmostApplicationInfo();
    if (application == nil) {
        return Fail(@"NO_FRONTMOST_APPLICATION", @"macOS did not report a frontmost application.", nil);
    }
    return WriteJSON(@{
        @"ok": @YES,
        @"app": application,
        @"inspectedAt": ISO8601Now()
    }, stdout, 0);
}

static int RunInspectUI(NSArray<NSString *> *arguments) {
    NSString *parseError = nil;
    NSDictionary<NSString *, NSString *> *options = ParseOptions(
        arguments,
        [NSSet setWithArray:@[@"--max-elements", @"--max-depth", @"--max-value-length"]],
        &parseError
    );
    if (options == nil) return Fail(@"INVALID_ARGUMENT", parseError, nil);

    NSInteger maxElements = kDefaultMaxElements;
    NSInteger maxDepth = kDefaultMaxDepth;
    NSInteger maxValueLength = kDefaultMaxValueLength;
    if ((options[@"--max-elements"] != nil &&
         !ParseInteger(options[@"--max-elements"], 1, 5000, &maxElements)) ||
        (options[@"--max-depth"] != nil &&
         !ParseInteger(options[@"--max-depth"], 0, 32, &maxDepth)) ||
        (options[@"--max-value-length"] != nil &&
         !ParseInteger(options[@"--max-value-length"], 0, 4096, &maxValueLength))) {
        return Fail(@"INVALID_ARGUMENT",
                    @"inspect-ui limits are invalid (max-elements 1..5000, max-depth 0..32, max-value-length 0..4096).",
                    nil);
    }

    int permissionResult = RequireAccessibilityPermission();
    if (permissionResult != 0) return permissionResult;

    NSDictionary *application = FrontmostApplicationInfo();
    if (application == nil) {
        return Fail(@"NO_FRONTMOST_APPLICATION", @"macOS did not report a frontmost application.", nil);
    }
    pid_t pid = (pid_t)[application[@"pid"] intValue];
    AXUIElementRef rootRef = AXUIElementCreateApplication(pid);
    if (rootRef == NULL) {
        return Fail(@"AX_TARGET_UNAVAILABLE", @"Unable to create an accessibility target for the frontmost application.", nil);
    }
    id root = CFBridgingRelease(rootRef);
    AXError rootError = kAXErrorSuccess;
    (void)CopyAttribute((__bridge AXUIElementRef)root, kAXRoleAttribute, &rootError);
    if (rootError != kAXErrorSuccess) {
        return Fail(@"AX_TARGET_UNAVAILABLE",
                    [NSString stringWithFormat:@"Unable to inspect the frontmost application (%@).", AXErrorName(rootError)],
                    @"Confirm the application is responsive and the bridge still has Accessibility permission.");
    }

    NSMutableArray<NSDictionary *> *queue = [NSMutableArray arrayWithObject:@{
        @"element": root,
        @"path": @"root",
        @"depth": @0
    }];
    NSMutableArray<NSDictionary *> *elements = [NSMutableArray arrayWithCapacity:(NSUInteger)maxElements];
    NSUInteger head = 0;
    BOOL depthLimited = NO;
    BOOL childLimited = NO;

    while (head < queue.count && elements.count < (NSUInteger)maxElements) {
        NSDictionary *item = queue[head++];
        AXUIElementRef element = (__bridge AXUIElementRef)item[@"element"];
        NSString *path = item[@"path"];
        NSInteger depth = [item[@"depth"] integerValue];
        [elements addObject:DescribeElement(element, path, maxValueLength)];

        NSUInteger pending = queue.count - head;
        NSUInteger available = (NSUInteger)maxElements > elements.count + pending
            ? (NSUInteger)maxElements - elements.count - pending
            : 0;
        AXError childrenError = kAXErrorSuccess;
        BOOL theseChildrenLimited = NO;
        NSArray *children = CopyChildrenBounded(element, available, &theseChildrenLimited, &childrenError);
        childLimited = childLimited || theseChildrenLimited;
        if (children.count == 0) continue;
        if (depth >= maxDepth) {
            depthLimited = YES;
            continue;
        }
        [children enumerateObjectsUsingBlock:^(id child, NSUInteger index, BOOL *stop) {
            (void)stop;
            if (CFGetTypeID((__bridge CFTypeRef)child) != AXUIElementGetTypeID()) return;
            NSString *childPath = [path isEqualToString:@"root"]
                ? [NSString stringWithFormat:@"%lu", (unsigned long)index]
                : [NSString stringWithFormat:@"%@.%lu", path, (unsigned long)index];
            [queue addObject:@{
                @"element": child,
                @"path": childPath,
                @"depth": @(depth + 1)
            }];
        }];
    }

    BOOL elementLimited = head < queue.count || childLimited;
    return WriteJSON(@{
        @"ok": @YES,
        @"app": application,
        @"elements": elements,
        @"elementCount": @(elements.count),
        @"truncated": @((BOOL)(elementLimited || depthLimited)),
        @"elementLimitReached": @(elementLimited),
        @"depthLimitReached": @(depthLimited),
        @"limits": @{
            @"maxElements": @(maxElements),
            @"maxDepth": @(maxDepth),
            @"maxValueLength": @(maxValueLength)
        },
        @"inspectedAt": ISO8601Now()
    }, stdout, 0);
}

static NSArray<NSNumber *> *ParseNumericPath(NSString *path) {
    if (path.length == 0 || path.length > 2048) return nil;
    NSArray<NSString *> *parts = [path componentsSeparatedByString:@"."];
    if (parts.count == 0 || parts.count > 64) return nil;
    NSCharacterSet *nonDigits = NSCharacterSet.decimalDigitCharacterSet.invertedSet;
    NSMutableArray<NSNumber *> *indexes = [NSMutableArray arrayWithCapacity:parts.count];
    for (NSString *part in parts) {
        if (part.length == 0 || [part rangeOfCharacterFromSet:nonDigits].location != NSNotFound) return nil;
        NSInteger index = 0;
        if (!ParseInteger(part, 0, NSIntegerMax, &index)) return nil;
        [indexes addObject:@(index)];
    }
    return indexes;
}

static int RunPressElement(NSArray<NSString *> *arguments) {
    NSString *parseError = nil;
    NSDictionary<NSString *, NSString *> *options = ParseOptions(
        arguments,
        [NSSet setWithArray:@[@"--pid", @"--path", @"--expected-role", @"--expected-title"]],
        &parseError
    );
    if (options == nil) return Fail(@"INVALID_ARGUMENT", parseError, nil);

    NSString *pidText = options[@"--pid"];
    NSString *path = options[@"--path"];
    NSString *expectedRole = options[@"--expected-role"];
    BOOL hasExpectedTitle = options[@"--expected-title"] != nil;
    NSString *expectedTitle = options[@"--expected-title"];
    NSInteger pidValue = 0;
    NSArray<NSNumber *> *pathIndexes = ParseNumericPath(path);
    if (!ParseInteger(pidText, 1, INT_MAX, &pidValue) || pathIndexes == nil ||
        expectedRole.length == 0 || expectedRole.length > 512 || expectedTitle.length > 4096) {
        return Fail(@"INVALID_ARGUMENT",
                    @"press-element requires --pid, numeric dot --path, non-empty --expected-role, and an optional bounded --expected-title.",
                    nil);
    }

    int permissionResult = RequireAccessibilityPermission();
    if (permissionResult != 0) return permissionResult;

    NSDictionary *application = FrontmostApplicationInfo();
    if (application == nil) {
        return Fail(@"NO_FRONTMOST_APPLICATION", @"macOS did not report a frontmost application.", nil);
    }
    if ([application[@"pid"] integerValue] != pidValue) {
        return Fail(@"FRONTMOST_APP_MISMATCH",
                    @"The inspected application is no longer frontmost; inspect the UI again before pressing an element.",
                    nil);
    }

    AXUIElementRef rootRef = AXUIElementCreateApplication((pid_t)pidValue);
    if (rootRef == NULL) {
        return Fail(@"AX_TARGET_UNAVAILABLE", @"Unable to create an accessibility target for the requested application.", nil);
    }
    id current = CFBridgingRelease(rootRef);
    for (NSNumber *pathIndex in pathIndexes) {
        AXError childrenError = kAXErrorSuccess;
        NSUInteger index = pathIndex.unsignedIntegerValue;
        id child = CopyChildAtIndex((__bridge AXUIElementRef)current, index, &childrenError);
        if (child == nil) {
            return Fail(@"ELEMENT_PATH_NOT_FOUND",
                        [NSString stringWithFormat:@"Element path %@ no longer exists (%@).", path, AXErrorName(childrenError)],
                        @"Inspect the UI again and use a fresh element path.");
        }
        if (CFGetTypeID((__bridge CFTypeRef)child) != AXUIElementGetTypeID()) {
            return Fail(@"ELEMENT_PATH_NOT_FOUND", @"The requested path did not resolve to an accessibility element.", nil);
        }
        current = child;
    }

    AXUIElementRef element = (__bridge AXUIElementRef)current;
    pid_t resolvedPID = 0;
    AXError pidError = AXUIElementGetPid(element, &resolvedPID);
    if (pidError != kAXErrorSuccess || resolvedPID != (pid_t)pidValue) {
        return Fail(@"ELEMENT_APP_MISMATCH", @"The resolved element does not belong to the expected application.", nil);
    }

    NSString *actualRole = StringAttribute(element, kAXRoleAttribute) ?: @"";
    NSString *actualTitle = StringAttribute(element, kAXTitleAttribute) ?: @"";
    if (![actualRole isEqualToString:expectedRole] ||
        (hasExpectedTitle && ![actualTitle isEqualToString:expectedTitle])) {
        return Fail(@"ELEMENT_FINGERPRINT_MISMATCH",
                    @"The element role or title changed; inspect the UI again before pressing it.",
                    nil);
    }

    NSArray<NSString *> *actions = ActionsForElement(element);
    if (![actions containsObject:(__bridge NSString *)kAXPressAction]) {
        return Fail(@"AX_PRESS_UNSUPPORTED", @"The selected element does not support AXPress.", nil);
    }

    NSDictionary *frontmostImmediatelyBeforePress = FrontmostApplicationInfo();
    if ([frontmostImmediatelyBeforePress[@"pid"] integerValue] != pidValue) {
        return Fail(@"FRONTMOST_APP_MISMATCH",
                    @"The frontmost application changed while resolving the element; no action was performed.",
                    nil);
    }

    AXError pressError = AXUIElementPerformAction(element, kAXPressAction);
    if (pressError != kAXErrorSuccess) {
        return Fail(@"AX_PRESS_FAILED",
                    [NSString stringWithFormat:@"AXPress failed (%@).", AXErrorName(pressError)],
                    nil);
    }

    return WriteJSON(@{
        @"ok": @YES,
        @"action": @"AXPress",
        @"app": application,
        @"element": @{
            @"path": path,
            @"role": actualRole,
            @"title": actualTitle
        },
        @"performedAt": ISO8601Now()
    }, stdout, 0);
}

static int RunDisplayInfo(void) {
    CGRect bounds = CGDisplayBounds(CGMainDisplayID());
    CGEventRef event = CGEventCreate(NULL);
    CGPoint cursor = event ? CGEventGetLocation(event) : CGPointZero;
    if (event) CFRelease(event);
    return WriteJSON(@{@"ok": @YES, @"coordinateSpace": @"global-logical-points",
        @"mainDisplay": @{@"x": @(bounds.origin.x), @"y": @(bounds.origin.y),
            @"width": @(bounds.size.width), @"height": @(bounds.size.height)},
        @"cursor": @{@"x": @(cursor.x), @"y": @(cursor.y)}}, stdout, 0);
}

static BOOL MouseNumber(id value, double minimum, double maximum) {
    return [value isKindOfClass:[NSNumber class]] && isfinite([value doubleValue])
        && [value doubleValue] >= minimum && [value doubleValue] <= maximum;
}

static BOOL PointOnDisplay(CGPoint point) {
    CGDirectDisplayID displays[32];
    uint32_t count = 0;
    if (CGGetActiveDisplayList(32, displays, &count) != kCGErrorSuccess) return NO;
    for (uint32_t index = 0; index < count; index++) {
        if (CGRectContainsPoint(CGDisplayBounds(displays[index]), point)) return YES;
    }
    return NO;
}

static int RunMouse(NSArray<NSString *> *arguments) {
    if (arguments.count != 1) return Fail(@"INVALID_ARGUMENT", @"mouse requires one JSON object.", nil);
    id request = [NSJSONSerialization JSONObjectWithData:[arguments[0] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    if (![request isKindOfClass:[NSDictionary class]]) return Fail(@"INVALID_ARGUMENT", @"Invalid mouse JSON.", nil);
    NSString *action = request[@"action"];
    if (![@[@"mouse_move", @"mouse_click", @"mouse_drag", @"mouse_scroll"] containsObject:action ?: @""])
        return Fail(@"INVALID_ARGUMENT", @"Unknown mouse action.", nil);
    if (!MouseNumber(request[@"x"], -100000, 100000) || !MouseNumber(request[@"y"], -100000, 100000))
        return Fail(@"INVALID_ARGUMENT", @"Invalid mouse coordinates.", nil);
    CGPoint from = CGPointMake([request[@"x"] doubleValue], [request[@"y"] doubleValue]);
    CGPoint to = from;
    BOOL drag = [action isEqualToString:@"mouse_drag"];
    BOOL click = [action isEqualToString:@"mouse_click"];
    BOOL scroll = [action isEqualToString:@"mouse_scroll"];
    if (drag) {
        if (!MouseNumber(request[@"toX"], -100000, 100000) || !MouseNumber(request[@"toY"], -100000, 100000)
            || !MouseNumber(request[@"durationMs"], 100, 3000))
            return Fail(@"INVALID_ARGUMENT", @"Invalid drag destination or duration.", nil);
        to = CGPointMake([request[@"toX"] doubleValue], [request[@"toY"] doubleValue]);
    }
    if (!PointOnDisplay(from) || !PointOnDisplay(to))
        return Fail(@"MOUSE_OUTSIDE_DISPLAY", @"Mouse coordinates must be within an active display, in logical points.", nil);
    NSString *buttonName = request[@"button"] ?: @"left";
    if (![@[@"left", @"right", @"middle"] containsObject:buttonName])
        return Fail(@"INVALID_ARGUMENT", @"Unknown mouse button.", nil);
    if (click && !MouseNumber(request[@"clickCount"], 1, 3))
        return Fail(@"INVALID_ARGUMENT", @"clickCount must be 1 to 3.", nil);
    if (scroll && (!MouseNumber(request[@"deltaX"], -2000, 2000) || !MouseNumber(request[@"deltaY"], -2000, 2000)))
        return Fail(@"INVALID_ARGUMENT", @"Invalid scroll deltas.", nil);
    NSArray *modifiers = request[@"modifiers"] ?: @[];
    if (![modifiers isKindOfClass:[NSArray class]] || modifiers.count > 4)
        return Fail(@"INVALID_ARGUMENT", @"Invalid modifiers.", nil);
    NSDictionary *flagMap = @{@"command": @(kCGEventFlagMaskCommand), @"control": @(kCGEventFlagMaskControl),
                             @"option": @(kCGEventFlagMaskAlternate), @"shift": @(kCGEventFlagMaskShift)};
    CGEventFlags flags = 0;
    for (id modifier in modifiers) {
        if (![modifier isKindOfClass:[NSString class]] || flagMap[modifier] == nil)
            return Fail(@"INVALID_ARGUMENT", @"Unknown modifier.", nil);
        flags |= [flagMap[modifier] unsignedLongLongValue];
    }
    int permissionResult = RequireAccessibilityPermission();
    if (permissionResult != 0) return permissionResult;
    CGMouseButton button = [buttonName isEqualToString:@"right"] ? kCGMouseButtonRight
        : [buttonName isEqualToString:@"middle"] ? kCGMouseButtonCenter : kCGMouseButtonLeft;
    CGEventType down = button == kCGMouseButtonRight ? kCGEventRightMouseDown
        : button == kCGMouseButtonCenter ? kCGEventOtherMouseDown : kCGEventLeftMouseDown;
    CGEventType up = button == kCGMouseButtonRight ? kCGEventRightMouseUp
        : button == kCGMouseButtonCenter ? kCGEventOtherMouseUp : kCGEventLeftMouseUp;
    CGEventType dragged = button == kCGMouseButtonRight ? kCGEventRightMouseDragged
        : button == kCGMouseButtonCenter ? kCGEventOtherMouseDragged : kCGEventLeftMouseDragged;
    // Allocate the complete bounded sequence before pressing anything, including release.
    NSMutableArray *events = [NSMutableArray array];
    NSMutableArray<NSNumber *> *delays = [NSMutableArray array];
    CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, from, button);
    if (!move) return Fail(@"MOUSE_EVENT_FAILED", @"Unable to create mouse event.", nil);
    [events addObject:CFBridgingRelease(move)];
    [delays addObject:@0.03];
    if (click || drag) {
        NSInteger count = click ? [request[@"clickCount"] integerValue] : 1;
        for (NSInteger index = 1; index <= count; index++) {
            CGEventRef press = CGEventCreateMouseEvent(NULL, down, from, button);
            CGEventRef release = CGEventCreateMouseEvent(NULL, up, to, button);
            if (!press || !release) {
                if (press) CFRelease(press);
                if (release) CFRelease(release);
                return Fail(@"MOUSE_EVENT_FAILED", @"Unable to create button events.", nil);
            }
            CGEventSetIntegerValueField(press, kCGMouseEventClickState, index);
            CGEventSetIntegerValueField(release, kCGMouseEventClickState, index);
            [events addObject:CFBridgingRelease(press)];
            [delays addObject:@0.03];
            if (drag) {
                for (int step = 1; step <= 60; step++) {
                    CGPoint position = CGPointMake(from.x + (to.x - from.x) * step / 60.0, from.y + (to.y - from.y) * step / 60.0);
                    CGEventRef event = CGEventCreateMouseEvent(NULL, dragged, position, button);
                    if (!event) { CFRelease(release); return Fail(@"MOUSE_EVENT_FAILED", @"Unable to create drag event.", nil); }
                    [events addObject:CFBridgingRelease(event)];
                    [delays addObject:@([request[@"durationMs"] doubleValue] / 60000.0)];
                }
            }
            [events addObject:CFBridgingRelease(release)];
            [delays addObject:@0.06];
        }
    } else if (scroll) {
        CGEventRef wheel = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2,
            -[request[@"deltaY"] intValue], -[request[@"deltaX"] intValue]);
        if (!wheel) return Fail(@"MOUSE_EVENT_FAILED", @"Unable to create scroll event.", nil);
        CGEventSetLocation(wheel, from);
        [events addObject:CFBridgingRelease(wheel)];
        [delays addObject:@0];
    }
    for (NSUInteger index = 0; index < events.count; index++) {
        CGEventRef event = (__bridge CGEventRef)events[index];
        CGEventSetFlags(event, flags);
        CGEventPost(kCGHIDEventTap, event);
        [NSThread sleepForTimeInterval:delays[index].doubleValue];
    }
    CGEventRef current = CGEventCreate(NULL);
    CGPoint cursor = current ? CGEventGetLocation(current) : to;
    if (current) CFRelease(current);
    return WriteJSON(@{@"ok": @YES, @"action": action, @"backend": @"native-cgevent",
        @"coordinateSpace": @"global-logical-points", @"cursor": @{@"x": @(cursor.x), @"y": @(cursor.y)},
        @"verificationRecommended": @YES}, stdout, 0);
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 2) {
            return Fail(@"INVALID_ARGUMENT",
                        @"Usage: chatwork-ax-helper <active-app|inspect-ui|press-element> [options]",
                        nil);
        }
        NSString *command = [NSString stringWithUTF8String:argv[1]];
        if (command == nil) return Fail(@"INVALID_ARGUMENT", @"Command must be valid UTF-8.", nil);

        NSMutableArray<NSString *> *arguments = [NSMutableArray arrayWithCapacity:(NSUInteger)MAX(0, argc - 2)];
        for (int index = 2; index < argc; index++) {
            NSString *argument = [NSString stringWithUTF8String:argv[index]];
            if (argument == nil) return Fail(@"INVALID_ARGUMENT", @"Arguments must be valid UTF-8.", nil);
            [arguments addObject:argument];
        }

        if ([command isEqualToString:@"active-app"]) return RunActiveApp(arguments);
        if ([command isEqualToString:@"inspect-ui"]) return RunInspectUI(arguments);
        if ([command isEqualToString:@"press-element"]) return RunPressElement(arguments);
        if ([command isEqualToString:@"mouse"]) return RunMouse(arguments);
        if ([command isEqualToString:@"display-info"]) return RunDisplayInfo();
        return Fail(@"UNKNOWN_COMMAND", [NSString stringWithFormat:@"Unknown command: %@", command], nil);
    }
}
