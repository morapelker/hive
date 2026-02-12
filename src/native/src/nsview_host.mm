// nsview_host.mm — NSView creation and BrowserWindow attachment
//
// Handles creating NSViews and positioning them within Electron's
// BrowserWindow using the native window handle.

#import <Cocoa/Cocoa.h>
#include "nsview_host.h"

namespace ghostty {

NSWindow* windowFromHandle(const void* handleBuffer, size_t bufferLength) {
  if (!handleBuffer || bufferLength < sizeof(void*)) {
    return nil;
  }

  // Electron's getNativeWindowHandle() returns a Buffer containing
  // the NSView* pointer of the window's content view.
  void* rawPtr = nullptr;
  memcpy(&rawPtr, handleBuffer, sizeof(void*));
  NSView* contentView = (__bridge NSView*)rawPtr;

  if (!contentView) {
    return nil;
  }

  return [contentView window];
}

NSView* createHostView(NSWindow* window, ViewRect rect) {
  if (!window) {
    return nil;
  }

  NSView* contentView = [window contentView];
  if (!contentView) {
    return nil;
  }

  // Convert from Electron's top-left origin to AppKit's bottom-left origin
  CGFloat contentHeight = contentView.bounds.size.height;
  NSRect frame = NSMakeRect(
    rect.x,
    contentHeight - rect.y - rect.height,
    rect.width,
    rect.height
  );

  NSView* hostView = [[NSView alloc] initWithFrame:frame];
  hostView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  hostView.wantsLayer = YES;

  // Metal rendering requires a layer-backed view
  hostView.layer.opaque = YES;

  [contentView addSubview:hostView];

  return hostView;
}

void setHostViewFrame(NSView* view, ViewRect rect) {
  if (!view || !view.superview) {
    return;
  }

  // Convert from top-left origin to bottom-left origin
  CGFloat superHeight = view.superview.bounds.size.height;
  NSRect frame = NSMakeRect(
    rect.x,
    superHeight - rect.y - rect.height,
    rect.width,
    rect.height
  );

  [view setFrame:frame];
}

void destroyHostView(NSView* view) {
  if (!view) {
    return;
  }
  [view removeFromSuperview];
}

double getScaleFactor(NSWindow* window) {
  if (!window) {
    return 1.0;
  }
  return [window backingScaleFactor];
}

} // namespace ghostty
