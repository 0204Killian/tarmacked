Pod::Spec.new do |s|
  s.name           = 'MotionActivity'
  s.version        = '1.0.0'
  s.summary        = 'Reads iOS motion activity (driving, walking, stationary) for tarmacked.'
  s.description    = s.summary
  s.author         = 'tarmacked'
  s.homepage       = 'https://tarmacked.com'
  s.license        = { :type => 'Proprietary' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.swift_version  = '5.9'
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'CoreMotion'
  s.source_files   = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
