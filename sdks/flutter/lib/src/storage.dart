import 'package:shared_preferences/shared_preferences.dart';

/// Where the SDK keeps its identity and queue.
abstract class KeyValueStore {
  Future<String?> get(String key);
  Future<void> set(String key, String value);
  Future<void> remove(String key);
}

/// Keeps nothing across restarts. For tests and short-lived processes.
class MemoryStore implements KeyValueStore {
  final Map<String, String> _values = {};

  @override
  Future<String?> get(String key) async => _values[key];

  @override
  Future<void> set(String key, String value) async => _values[key] = value;

  @override
  Future<void> remove(String key) async => _values.remove(key);
}

/// SharedPreferences (NSUserDefaults on iOS, SharedPreferences on Android): persisted on disk.
class SharedPreferencesStore implements KeyValueStore {
  SharedPreferences? _prefs;

  Future<SharedPreferences> _instance() async => _prefs ??= await SharedPreferences.getInstance();

  @override
  Future<String?> get(String key) async => (await _instance()).getString(key);

  @override
  Future<void> set(String key, String value) async {
    await (await _instance()).setString(key, value);
  }

  @override
  Future<void> remove(String key) async {
    await (await _instance()).remove(key);
  }
}
