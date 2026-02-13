// nsview_host.mm — NSView creation and BrowserWindow attachment
//
// Handles creating NSViews and positioning them within Electron's
// BrowserWindow using the native window handle.

#import <Cocoa/Cocoa.h>
#include <IOKit/hidsystem/ev_keymap.h>
#include <string>
#include "nsview_host.h"
#include "ghostty_bridge.h"

namespace {

ghostty_input_mouse_button_e mouseButtonFromNumber(NSInteger buttonNumber) {
  switch (buttonNumber) {
    case 0:
      return GHOSTTY_MOUSE_LEFT;
    case 1:
      return GHOSTTY_MOUSE_RIGHT;
    case 2:
      return GHOSTTY_MOUSE_MIDDLE;
    case 3:
      return GHOSTTY_MOUSE_EIGHT;
    case 4:
      return GHOSTTY_MOUSE_NINE;
    case 5:
      return GHOSTTY_MOUSE_SIX;
    case 6:
      return GHOSTTY_MOUSE_SEVEN;
    case 7:
      return GHOSTTY_MOUSE_FOUR;
    case 8:
      return GHOSTTY_MOUSE_FIVE;
    case 9:
      return GHOSTTY_MOUSE_TEN;
    case 10:
      return GHOSTTY_MOUSE_ELEVEN;
    default:
      return GHOSTTY_MOUSE_UNKNOWN;
  }
}

ghostty_input_mods_e ghosttyModsFromFlags(NSEventModifierFlags flags) {
  uint32_t mods = GHOSTTY_MODS_NONE;

  if (flags & NSEventModifierFlagShift) mods |= GHOSTTY_MODS_SHIFT;
  if (flags & NSEventModifierFlagControl) mods |= GHOSTTY_MODS_CTRL;
  if (flags & NSEventModifierFlagOption) mods |= GHOSTTY_MODS_ALT;
  if (flags & NSEventModifierFlagCommand) mods |= GHOSTTY_MODS_SUPER;
  if (flags & NSEventModifierFlagCapsLock) mods |= GHOSTTY_MODS_CAPS;

  const NSUInteger raw = flags;
  if (raw & NX_DEVICERSHIFTKEYMASK) mods |= GHOSTTY_MODS_SHIFT_RIGHT;
  if (raw & NX_DEVICERCTLKEYMASK) mods |= GHOSTTY_MODS_CTRL_RIGHT;
  if (raw & NX_DEVICERALTKEYMASK) mods |= GHOSTTY_MODS_ALT_RIGHT;
  if (raw & NX_DEVICERCMDKEYMASK) mods |= GHOSTTY_MODS_SUPER_RIGHT;

  return static_cast<ghostty_input_mods_e>(mods);
}

ghostty_input_mods_e ghosttyConsumedModsFromFlags(NSEventModifierFlags flags) {
  const NSEventModifierFlags filtered =
    flags & ~(NSEventModifierFlagControl | NSEventModifierFlagCommand);
  return ghosttyModsFromFlags(filtered);
}

uint32_t unshiftedCodepointForEvent(NSEvent* event) {
  NSString* chars = [event charactersByApplyingModifiers:0];
  if (!chars || chars.length == 0) return 0;
  return static_cast<uint32_t>([chars characterAtIndex:0]);
}

std::string eventTextForGhostty(NSEvent* event) {
  NSString* chars = event.characters;
  if (!chars || chars.length == 0) return "";

  if (chars.length == 1) {
    const unichar scalar = [chars characterAtIndex:0];

    // For control chars, send characters with control removed.
    if (scalar < 0x20) {
      NSString* withoutControl =
        [event charactersByApplyingModifiers:(event.modifierFlags & ~NSEventModifierFlagControl)];
      if (!withoutControl || withoutControl.length == 0) return "";
      const char* utf8 = [withoutControl UTF8String];
      return utf8 ? std::string(utf8) : std::string();
    }

    // Ignore PUA function-key surrogates.
    if (scalar >= 0xF700 && scalar <= 0xF8FF) {
      return "";
    }
  }

  const char* utf8 = [chars UTF8String];
  return utf8 ? std::string(utf8) : std::string();
}

uint8_t momentumFromEventPhase(NSEventPhase phase) {
  if (phase & NSEventPhaseBegan) return GHOSTTY_MOUSE_MOMENTUM_BEGAN;
  if (phase & NSEventPhaseStationary) return GHOSTTY_MOUSE_MOMENTUM_STATIONARY;
  if (phase & NSEventPhaseChanged) return GHOSTTY_MOUSE_MOMENTUM_CHANGED;
  if (phase & NSEventPhaseEnded) return GHOSTTY_MOUSE_MOMENTUM_ENDED;
  if (phase & NSEventPhaseCancelled) return GHOSTTY_MOUSE_MOMENTUM_CANCELLED;
  if (phase & NSEventPhaseMayBegin) return GHOSTTY_MOUSE_MOMENTUM_MAY_BEGIN;
  return GHOSTTY_MOUSE_MOMENTUM_NONE;
}

} // namespace

@interface GhosttyHostView : NSView
@property(nonatomic, assign) uint32_t surfaceId;
@end

@implementation GhosttyHostView

- (BOOL)acceptsFirstResponder {
  return YES;
}

- (BOOL)acceptsFirstMouse:(NSEvent*)event {
  (void)event;
  return YES;
}

- (BOOL)becomeFirstResponder {
  const BOOL result = [super becomeFirstResponder];
  if (result && self.surfaceId != 0) {
    ghostty::GhosttyBridge::instance().setSurfaceFocus(self.surfaceId, true);
  }
  return result;
}

- (BOOL)resignFirstResponder {
  const BOOL result = [super resignFirstResponder];
  if (result && self.surfaceId != 0) {
    ghostty::GhosttyBridge::instance().setSurfaceFocus(self.surfaceId, false);
  }
  return result;
}

- (void)updateTrackingAreas {
  [super updateTrackingAreas];
  for (NSTrackingArea* area in self.trackingAreas) {
    [self removeTrackingArea:area];
  }

  NSTrackingAreaOptions options =
    NSTrackingMouseMoved | NSTrackingMouseEnteredAndExited | NSTrackingInVisibleRect | NSTrackingActiveAlways;
  NSTrackingArea* area = [[NSTrackingArea alloc] initWithRect:self.bounds
                                                      options:options
                                                        owner:self
                                                     userInfo:nil];
  [self addTrackingArea:area];
}

- (void)sendMousePos:(NSEvent*)event {
  if (self.surfaceId == 0) return;

  NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
  const double x = p.x;
  const double y = NSHeight(self.bounds) - p.y;
  const auto mods = ghosttyModsFromFlags(event.modifierFlags);
  ghostty::GhosttyBridge::instance().mousePos(self.surfaceId, x, y, mods);
}

- (void)mouseDown:(NSEvent*)event {
  [self.window makeFirstResponder:self];
  if (self.surfaceId == 0) return;
  ghostty::GhosttyBridge::instance().mouseButton(
    self.surfaceId,
    GHOSTTY_MOUSE_PRESS,
    GHOSTTY_MOUSE_LEFT,
    ghosttyModsFromFlags(event.modifierFlags)
  );
}

- (void)mouseUp:(NSEvent*)event {
  if (self.surfaceId == 0) return;
  ghostty::GhosttyBridge::instance().mouseButton(
    self.surfaceId,
    GHOSTTY_MOUSE_RELEASE,
    GHOSTTY_MOUSE_LEFT,
    ghosttyModsFromFlags(event.modifierFlags)
  );
}

- (void)rightMouseDown:(NSEvent*)event {
  [self.window makeFirstResponder:self];
  if (self.surfaceId == 0) return;
  ghostty::GhosttyBridge::instance().mouseButton(
    self.surfaceId,
    GHOSTTY_MOUSE_PRESS,
    GHOSTTY_MOUSE_RIGHT,
    ghosttyModsFromFlags(event.modifierFlags)
  );
}

- (void)rightMouseUp:(NSEvent*)event {
  if (self.surfaceId == 0) return;
  ghostty::GhosttyBridge::instance().mouseButton(
    self.surfaceId,
    GHOSTTY_MOUSE_RELEASE,
    GHOSTTY_MOUSE_RIGHT,
    ghosttyModsFromFlags(event.modifierFlags)
  );
}

- (void)otherMouseDown:(NSEvent*)event {
  [self.window makeFirstResponder:self];
  if (self.surfaceId == 0) return;
  ghostty::GhosttyBridge::instance().mouseButton(
    self.surfaceId,
    GHOSTTY_MOUSE_PRESS,
    mouseButtonFromNumber(event.buttonNumber),
    ghosttyModsFromFlags(event.modifierFlags)
  );
}

- (void)otherMouseUp:(NSEvent*)event {
  if (self.surfaceId == 0) return;
  ghostty::GhosttyBridge::instance().mouseButton(
    self.surfaceId,
    GHOSTTY_MOUSE_RELEASE,
    mouseButtonFromNumber(event.buttonNumber),
    ghosttyModsFromFlags(event.modifierFlags)
  );
}

- (void)mouseMoved:(NSEvent*)event {
  [self sendMousePos:event];
}

- (void)mouseDragged:(NSEvent*)event {
  [self sendMousePos:event];
}

- (void)rightMouseDragged:(NSEvent*)event {
  [self sendMousePos:event];
}

- (void)otherMouseDragged:(NSEvent*)event {
  [self sendMousePos:event];
}

- (void)mouseExited:(NSEvent*)event {
  if (self.surfaceId == 0) return;
  ghostty::GhosttyBridge::instance().mousePos(
    self.surfaceId,
    -1,
    -1,
    ghosttyModsFromFlags(event.modifierFlags)
  );
}

- (void)scrollWheel:(NSEvent*)event {
  if (self.surfaceId == 0) return;

  double dx = event.scrollingDeltaX;
  double dy = event.scrollingDeltaY;
  const bool precision = event.hasPreciseScrollingDeltas;
  if (precision) {
    dx *= 2;
    dy *= 2;
  }

  const uint8_t momentum = momentumFromEventPhase(event.momentumPhase);
  const int scrollMods = (precision ? 1 : 0) | (static_cast<int>(momentum) << 1);

  ghostty::GhosttyBridge::instance().mouseScroll(self.surfaceId, dx, dy, scrollMods);
}

- (void)keyDown:(NSEvent*)event {
  if (self.surfaceId == 0) {
    [super keyDown:event];
    return;
  }

  const auto action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS;
  const auto mods = ghosttyModsFromFlags(event.modifierFlags);
  const auto consumedMods = ghosttyConsumedModsFromFlags(event.modifierFlags);
  const auto text = eventTextForGhostty(event);

  ghostty::GhosttyBridge::instance().keyEvent(
    self.surfaceId,
    action,
    static_cast<uint32_t>(event.keyCode),
    mods,
    consumedMods,
    text,
    unshiftedCodepointForEvent(event),
    false
  );
}

- (void)keyUp:(NSEvent*)event {
  if (self.surfaceId == 0) {
    [super keyUp:event];
    return;
  }

  ghostty::GhosttyBridge::instance().keyEvent(
    self.surfaceId,
    GHOSTTY_ACTION_RELEASE,
    static_cast<uint32_t>(event.keyCode),
    ghosttyModsFromFlags(event.modifierFlags),
    ghosttyConsumedModsFromFlags(event.modifierFlags),
    "",
    unshiftedCodepointForEvent(event),
    false
  );
}

@end

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

  GhosttyHostView* hostView = [[GhosttyHostView alloc] initWithFrame:frame];
  hostView.surfaceId = 0;
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

void setHostViewSurfaceId(NSView* view, uint32_t surfaceId) {
  if (!view || ![view isKindOfClass:[GhosttyHostView class]]) {
    return;
  }

  GhosttyHostView* hostView = (GhosttyHostView*)view;
  hostView.surfaceId = surfaceId;
}

void focusHostView(NSView* view) {
  if (!view || !view.window) {
    return;
  }

  [view.window makeFirstResponder:view];
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
