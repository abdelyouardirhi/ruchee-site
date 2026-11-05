# Leaflet 1.9.4

Pinned, self-hosted browser distribution from https://unpkg.com/leaflet@1.9.4/.
JS, CSS and distribution image assets are unchanged; license retained in LICENSE.

The marketing demonstration uses Leaflet instead of the dashboard's WebGL map so it also works on low-powered phones without a WebGL renderer. The map library loads only near the map section. It is a read-only animation: no dragging, zooming, site selection or scenario selection. Only pause/resume is offered. No production data, location APIs or outbound business messages are involved.

Tiles: https://tile.openstreetmap.org/{z}/{x}/{y}.png
Policy: https://operations.osmfoundation.org/policies/tiles/

Only the visible viewport is requested, through the browser with normal caching and referrer behavior. There is no prefetch, offline download, proxy or automatic camera tour. Attribution remains visible. The tile URL is configured on #demo-map in index.html.

Automated animation tests must stub external tiles rather than repeatedly request the public service.
