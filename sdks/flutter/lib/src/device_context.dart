import 'dart:io' show Platform;
import 'dart:ui' show PlatformDispatcher;

String _cap(String s, int max) => s.length > max ? s.substring(0, max) : s;

/// OS version, locale, language and screen, read on each event. Device model and IANA timezone need
/// plugins (device_info_plus, flutter_timezone); pass them through `context` when you use those.
Map<String, Object?> flutterContext() {
  final ctx = <String, Object?>{};
  try {
    ctx['os_version'] = _cap(Platform.operatingSystemVersion, 50);
    ctx['os'] = Platform.operatingSystem;
  } catch (_) {
    // not available on this platform
  }
  final dispatcher = PlatformDispatcher.instance;
  final locale = dispatcher.locale;
  ctx['locale'] = _cap(locale.toLanguageTag(), 35);
  ctx['language'] = locale.languageCode;
  final views = dispatcher.views;
  if (views.isNotEmpty) {
    final view = views.first;
    if (view.physicalSize.width > 0) {
      ctx['screen'] = {
        'width': view.physicalSize.width.round(),
        'height': view.physicalSize.height.round(),
        'density': view.devicePixelRatio,
      };
    }
  }
  return ctx;
}
