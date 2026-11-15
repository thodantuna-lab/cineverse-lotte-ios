require 'xcodeproj'
require 'fileutils'
require 'plist'

project_path = 'ios/App/App.xcodeproj'
project = Xcodeproj::Project.open(project_path)

app_target = project.targets.find { |t| t.name == 'App' }
raise 'App target not found' unless app_target

# 1. Copy plugin files into ios/App/App/
app_dir = 'ios/App/App'
FileUtils.cp('ios-native-template/ReplayKitBridgePlugin.swift', "#{app_dir}/ReplayKitBridgePlugin.swift")
FileUtils.cp('ios-native-template/ReplayKitBridgePlugin.m', "#{app_dir}/ReplayKitBridgePlugin.m")

app_group = project.main_group.find_subpath('App', true)
swift_ref = app_group.files.find { |f| f.path == 'ReplayKitBridgePlugin.swift' } || app_group.new_file('ReplayKitBridgePlugin.swift')
m_ref = app_group.files.find { |f| f.path == 'ReplayKitBridgePlugin.m' } || app_group.new_file('ReplayKitBridgePlugin.m')

app_target.source_build_phase.add_file_reference(swift_ref, true)
app_target.source_build_phase.add_file_reference(m_ref, true)

# Ensure bridging header / Swift version & ReplayKit/Network frameworks on App
app_target.build_configurations.each do |cfg|
  cfg.build_settings['SWIFT_VERSION'] = '5.0'
  cfg.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '14.0'
end

# 2. Update App Info.plist with Camera, Mic & Local Network permissions
plist_path = "#{app_dir}/Info.plist"
plist = Plist.parse_xml(plist_path) || {}
plist['NSCameraUsageDescription'] ||= 'CineVerse dùng Camera để bạn bật Cam cùng bạn bè trong Phòng Stream.'
plist['NSMicrophoneUsageDescription'] ||= 'CineVerse dùng Micro để bạn nói chuyện trực tiếp trong Phòng Stream.'
plist['NSLocalNetworkUsageDescription'] ||= 'CineVerse dùng kết nối nội bộ để nhận khung hình ReplayKit khi chia sẻ màn hình.'
File.write(plist_path, plist.to_plist)

# 3. Create ReplayKitExtension target if not present
ext_name = 'ReplayKitExtension'
ext_dir = "ios/App/#{ext_name}"
FileUtils.mkdir_p(ext_dir)
FileUtils.cp('ios-native-template/SampleHandler.swift', "#{ext_dir}/SampleHandler.swift")
FileUtils.cp('ios-native-template/Extension-Info.plist', "#{ext_dir}/Info.plist")

ext_target = project.targets.find { |t| t.name == ext_name }
unless ext_target
  ext_target = project.new_target(:app_extension, ext_name, :ios, '14.0')
  ext_group = project.main_group.new_group(ext_name, ext_name)
  sample_ref = ext_group.new_file('SampleHandler.swift')
  ext_group.new_file('Info.plist')
  ext_target.source_build_phase.add_file_reference(sample_ref, true)

  ext_target.build_configurations.each do |cfg|
    cfg.build_settings['PRODUCT_NAME'] = '$(TARGET_NAME)'
    cfg.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = 'com.cineverse.lotte.ReplayKitExtension'
    cfg.build_settings['INFOPLIST_FILE'] = "#{ext_name}/Info.plist"
    cfg.build_settings['GENERATE_INFOPLIST_FILE'] = 'NO'
    cfg.build_settings['SDKROOT'] = 'iphoneos'
    cfg.build_settings['TARGETED_DEVICE_FAMILY'] = '1,2'
    cfg.build_settings['SWIFT_VERSION'] = '5.0'
    cfg.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '14.0'
    cfg.build_settings['CODE_SIGN_STYLE'] = 'Automatic'
    cfg.build_settings['SKIP_INSTALL'] = 'YES'
    cfg.build_settings['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
  end

  # Embed extension in App target
  app_target.add_dependency(ext_target)
  embed_phase = app_target.copy_files_build_phases.find { |p| p.name == 'Embed App Extensions' } ||
                app_target.new_copy_files_build_phase('Embed App Extensions')
  embed_phase.dst_subfolder_spec = '13' # PlugIns
  embed_phase.add_file_reference(ext_target.product_reference, true)
end

project.save
puts 'Successfully configured ReplayKitBridgePlugin and ReplayKitExtension!'
