{
  "targets": [
    {
      "target_name": "ghostty",
      "sources": [
        "src/addon.mm",
        "src/ghostty_bridge.mm",
        "src/nsview_host.mm"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "include"
      ],
      "libraries": [
        "<!(echo ${GHOSTTY_LIB_PATH:-$HOME/Documents/dev/ghostty/macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a})"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "GCC_ENABLE_OBJC_EXCEPTIONS": "YES",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "OTHER_CPLUSPLUSFLAGS": [
              "-std=c++17",
              "-ObjC++",
              "-fno-exceptions"
            ],
            "OTHER_LDFLAGS": [
              "-ObjC"
            ],
            "MACOSX_DEPLOYMENT_TARGET": "13.0"
          },
          "link_settings": {
            "libraries": [
              "-framework Metal",
              "-framework MetalKit",
              "-framework QuartzCore",
              "-framework CoreText",
              "-framework CoreGraphics",
              "-framework Foundation",
              "-framework AppKit",
              "-framework IOSurface",
              "-framework IOKit",
              "-framework Carbon",
              "-framework CoreFoundation",
              "-framework Security",
              "-framework UniformTypeIdentifiers",
              "-framework GameController",
              "-lz",
              "-lc++"
            ]
          }
        }]
      ]
    }
  ]
}
