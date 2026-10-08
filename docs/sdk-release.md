# SDK release checklist

Nothing is published automatically. The **SDK release dry run** workflow
(`.github/workflows/sdk-release-dry-run.yml`, run by hand) builds every SDK the
way a release would and keeps the packages as workflow artifacts. Publishing
needs registry accounts the owner has not created yet.

| SDK | Package today | Dry run produces | Before the first real release (owner) |
| --- | --- | --- | --- |
| JavaScript / React Native | `@leanapp/analytics`, `private: true` | npm tarball | npm organization `leanapp`; remove `private`; choose a licence |
| Android | Gradle, version `0.1.0`, no publishing plugin | core JAR + Android AAR | Maven Central namespace (`io.leanapp`), signing key; add `maven-publish` |
| iOS | Swift Package | release builds for device and simulator | a version tag on the repository (SwiftPM installs from Git tags) |
| Flutter | `leanapp_analytics`, `publish_to: none` | analysis and tests | pub.dev publisher (verified `leanapp.io`); remove `publish_to` |

When an SDK is published, set `published: true` for it in
`apps/platform/src/modules/implementation/sdks.ts` and change its quickstart from
the repository path to the registry install; the dashboard then drops the
"Not published" label. Until then the dashboard says to add it from the repository.

## Each release

1. All SDK jobs green in CI on the commit.
2. Version bumped in one commit for every SDK that changed; changelog entry.
3. Run the dry-run workflow on that commit; download and inspect the artifacts
   (package contents, no test files or secrets, size).
4. Test against staging with a sample app: install, `track`, `identify`, offline queue.
5. Publish (owner credentials) and tag `sdk-<name>-v<version>`.
