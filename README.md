# Ad Blocker for Spotify Web
This is an experimental, simple chrome extension to remove audio ads on Spotify web player.
It's available on the [Chrome Web Store](https://chrome.google.com/webstore/detail/spotify-ads-remover/mghhlojofjipigjobacbjdngmjafdeim?hl=iw&authuser=0) too.

## How ads are removed
Ads are removed by intercepting and then tampering with Spotify's state machine requests/updates on the fly. 

The states are modified so that states that represent ads are skipped over (pointing to the state afterwards). This is done in `ads_removal.js`.

## Firefox/Safari Support
Possibly [here](https://github.com/tomer8007/spotify-web-ads-remover/pull/2) and [there](https://github.com/tomer8007/spotify-web-ads-remover/pull/8).

## Playback compatibility fixes in this fork

The player keeps the intended post-ad track when a future-state response points
at a different track index. After obtaining an ad-free future state it does not
request restoration of the original ad-bearing machine. Ordinary WebSocket
updates and outgoing state/Connect requests bypass the ad-processing queue;
ad-bearing and previously rewritten states still use the removal path.

Run the dependency-free regression tests with Node.js 18 or later:

```sh
node --test tests/*.test.cjs
```

These tests cover state selection, request ordering, and preservation of ad
processing. They do not replace testing against a signed-in Spotify player.

## Privacy policy
No data is ever transmitted to anywhere. No backend, no analytics, no server.

You can find the privacy policy [here](https://github.com/tomer8007/spotify-web-ads-remover/wiki/Chrome-Extension-Privacy-Policy).

## Other notices
There is the competing Blockify extension, which started as a fork of this project. Its [ads_removal.js](https://github.com/dhanur2/blockify-browser-extension/blob/main/injected/ads_removal.js) is mostly the same as the original [ads_removal.js](https://github.com/tomer8007/spotify-web-ads-remover/blob/3a9f5aca9886c3e2868d4133537d492bab137c5d/injected/ads_removal.js) here. Also its [AdsRemovalV1.js](https://github.com/dhanur2/blockify-browser-extension/blob/14308602c93ed2974190bbeca38f0edb3b90b493/injected/adsRemovalV1.js) still relies on `/state` and WebSocket `replace_state` interception.
