Pod::Spec.new do |s|
  s.name           = 'PasteImage'
  s.version        = '1.0.0'
  s.summary        = 'Pasting images into the composer'
  s.description    = 'Lets React Native text inputs take a pasted image and hands it to JavaScript.'
  s.license        = 'MIT'
  s.author         = 'TerminalX'
  s.homepage       = 'https://github.com/terminalx-ai/terminalx'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
