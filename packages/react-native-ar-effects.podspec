Pod::Spec.new do |s|
  s.name             = "react-native-ar-effects"
  s.version          = "0.1.5"
  s.summary          = "Open-source face tracking + AR effects for React Native live video"
  s.description      = "MediaPipe Face Landmarker behind one DetectionProvider interface, with a camera preview view for live landmark overlays, plus host-side pre-encode filters that plug into LiveKit's video-effect pipeline."
  s.homepage         = "https://github.com/realkevonporter/react-native-ar-effects"
  s.license          = { :type => "Apache-2.0", :file => "LICENSE" }
  s.author           = "Kevon Porter"
  s.platforms        = { :ios => "13.0" }
  s.source           = { :git => "https://github.com/realkevonporter/react-native-ar-effects.git", :tag => s.version.to_s }
  s.source_files     = "ios/*.{swift,m}"
  s.resources        = "ios/face_landmarker.task"
  s.dependency "React-Core"
  s.dependency "MediaPipeTasksVision", "~> 0.10.14"
  # M3: the LiveKit React Native fork's VideoEffect registry. Pins
  # must match the host app's fork version: the fork's podspec pins
  # WebRTC-SDK =144.7559.10 for @livekit/react-native-webrtc 144.1.2.
  # First-build CocoaPods resolution confirms both.
  s.dependency "livekit-react-native-webrtc", "~> 144.1"
  s.dependency "WebRTC-SDK", "= 144.7559.10"
  s.swift_version    = "5.0"
  s.pod_target_xcconfig = { "DEFINES_MODULE" => "YES" }
end
