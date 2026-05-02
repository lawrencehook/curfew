# Curb

Browser extension that sets daily caps and leaky-bucket rate limits on distracting sites. Firefox (MV2) and Chrome (MV3).

## Local testing

`./dev.sh <firefox|chrome>` lets both browsers run side-by-side without clobbering each other's `manifest.json`.

```bash
./dev.sh firefox     # writes src/manifest.json, launches web-ext run
./dev.sh chrome      # builds dist/chrome/ — load as unpacked in chrome://extensions
```

Firefox runs from `src/` directly (web-ext doesn't reliably load scripts through directory symlinks). Chrome runs from `dist/chrome/`, which is a tree of symlinks back into `src/` with `chrome_manifest.json` copied in. The two manifests live at different paths, so neither browser's setup affects the other. Edits in `src/` propagate live to both.

## Release

```bash
# Tag and push — CI builds Chrome + Firefox zips and attaches them to a GitHub Release
git tag -a v0.1.0 -m "v0.1.0" && git push --tags
```
