#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// ObjC bridge for the Swift ARFilter module (M3).
//
// The Swift class declares its methods with @objc, but under the New
// Architecture the JS runtime does not see them: NativeModules.ARFilter
// resolves, yet registerProcessor/setFilter are not functions on it
// (proven on-device 2026-11-03: "probe: ARFilter.registerProcessor is
// not a function"). RCT_EXTERN_METHOD registers the methods through the
// macro system, which the runtime does see, forwarding each call to the
// Swift implementation. Selectors must match the Swift declarations
// exactly: registerProcessor:rejecter:, setFilter:resolver:rejecter:,
// clearFilter:rejecter:.
@interface RCT_EXTERN_MODULE(ARFilter, RCTEventEmitter)
RCT_EXTERN_METHOD(registerProcessor:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(setFilter:(NSString *)effectJson resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(clearFilter:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
@end
