Pod::Spec.new do |s|
  s.name           = 'SpotifyRemote'
  s.version        = '1.0.0'
  s.summary        = 'Now playing and playback controls for the Spotify app, for tarmacked.'
  s.description    = s.summary
  s.author         = 'tarmacked'
  s.homepage       = 'https://tarmacked.com'
  s.license        = { :type => 'Proprietary' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.swift_version  = '5.9'
  s.dependency 'ExpoModulesCore'
  # Spotify's iOS SDK (github.com/spotify/ios-sdk v5.0.1), unmodified.
  s.vendored_frameworks = 'SpotifyiOS.xcframework'
  s.source_files   = '*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
