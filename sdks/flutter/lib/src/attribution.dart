/// Campaign parameters and ad-network click ids captured from deep links and landing URLs.
const List<String> attributionParams = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'ttclid',
  'ScCid',
  'twclid',
  'li_fat_id',
  'msclkid',
  'click_id',
];

String _truncate(String s, int max) => s.length > max ? s.substring(0, max) : s;

/// Extracts attribution parameters from a URL or query string; null when there are none.
/// Same rules as the JavaScript SDK: case-insensitive names, values capped at 1,000 characters.
Map<String, String>? parseAttribution(String url) {
  var search = url;
  final q = url.indexOf('?');
  if (q >= 0) search = url.substring(q + 1);
  final hash = search.indexOf('#');
  if (hash >= 0) search = search.substring(0, hash);
  final out = <String, String>{};
  for (final pair in search.split('&')) {
    if (pair.isEmpty) continue;
    final parts = pair.split('=');
    String k;
    String v;
    try {
      k = Uri.decodeComponent(parts[0].replaceAll('+', ' '));
      v = Uri.decodeComponent((parts.length > 1 ? parts[1] : '').replaceAll('+', ' '));
    } catch (_) {
      continue;
    }
    for (final p in attributionParams) {
      if (p.toLowerCase() == k.toLowerCase() && v.isNotEmpty) {
        out[p] = _truncate(v, 1000);
        break;
      }
    }
  }
  return out.isEmpty ? null : out;
}

/// Google Play Install Referrer details (Android). Get them with a plugin such as
/// play_install_referrer and pass them to `Analytics.setInstallReferrer`.
class InstallReferrer {
  const InstallReferrer(
    this.referrer, {
    this.referrerClickTimestampSeconds = 0,
    this.installBeginTimestampSeconds = 0,
    this.googlePlayInstant = false,
  });

  final String referrer;
  final int referrerClickTimestampSeconds;
  final int installBeginTimestampSeconds;
  final bool googlePlayInstant;

  /// Sent as context.campaign on every event.
  Map<String, Object?> toContext() => {
        'install_referrer': _truncate(referrer, 1000),
        'referrer_click_timestamp_seconds': referrerClickTimestampSeconds,
        'install_begin_timestamp_seconds': installBeginTimestampSeconds,
        'google_play_instant': googlePlayInstant,
      };

  Map<String, Object?> toJson() => {
        'referrer': referrer,
        'clickTs': referrerClickTimestampSeconds,
        'installTs': installBeginTimestampSeconds,
        'instant': googlePlayInstant,
      };

  static InstallReferrer? fromJson(Object? v) {
    if (v is! Map) return null;
    final r = v['referrer'];
    if (r is! String) return null;
    return InstallReferrer(
      r,
      referrerClickTimestampSeconds: (v['clickTs'] as num?)?.toInt() ?? 0,
      installBeginTimestampSeconds: (v['installTs'] as num?)?.toInt() ?? 0,
      googlePlayInstant: v['instant'] == true,
    );
  }
}
