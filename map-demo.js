(function initMapDemo() {
  "use strict";

  // This below-the-fold stylesheet must not delay the hero's first paint.
  var styles = document.getElementById("map-demo-styles");
  if (styles && styles.media !== "all") {
    if (!styles.sheet) {
      styles.addEventListener("load", initMapDemo, { once: true });
      return;
    }
    styles.media = "all";
  }
  var root = document.querySelector("#carte[data-map-demo]");
  if (!root || root.dataset.mapBound === "true") return;
  root.dataset.mapBound = "true";

  var find = function (name) {
    return root.querySelector("[data-map-" + name + "]");
  };
  var mapNode = root.querySelector("#demo-map");
  var statusNode = find("status");
  var playButton = find("play");
  var workspace =
    root.querySelector(".map-workspace") ||
    root.querySelector(".map-demo-app") ||
    mapNode ||
    root;
  var motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var states = {
    uncovered: { label: "À couvrir", glyph: "!", color: "#b42318" },
    planned: { label: "Prévu", glyph: "◷", color: "#5b574c" },
    late: { label: "Retard signalé", glyph: "!", color: "#a65c00" },
    arrived: { label: "Arrivée", glyph: "✓", color: "#1f7a5a" },
    replaced: { label: "Remplacement confirmé", glyph: "↻", color: "#1b1a16" },
  };
  var baseline = [
    {
      id: "horizon",
      name: "Résidence Horizon",
      type: "Bureaux · Jeanne-d’Arc",
      coords: [43.6109, 1.4451],
      time: "8h00–11h00",
      worker: "Maria",
      status: "uncovered",
      detail: "Maria a signalé son absence. Le créneau reste à couvrir.",
    },
    {
      id: "martin",
      name: "Maison Martin",
      type: "Particulier · Saint-Cyprien",
      coords: [43.6001, 1.4308],
      time: "8h00–10h00",
      worker: "Aïcha",
      status: "planned",
      detail: "La prestation est prévue à 8h00. Aucun pointage enregistré.",
    },
    {
      id: "carmes",
      name: "Commerce des Carmes",
      type: "Commerce · Les Carmes",
      coords: [43.5964, 1.4444],
      time: "8h00–10h00",
      worker: "Noah",
      status: "late",
      detail:
        "Noah a annoncé 20 minutes de retard. Léa prévient le patron pendant le scénario.",
    },
    {
      id: "dupont",
      name: "Bureaux Dupont",
      type: "Bureaux · Matabiau",
      coords: [43.6108, 1.4567],
      time: "7h00–10h00",
      worker: "Fatima",
      status: "arrived",
      detail: "Arrivée enregistrée par QR code à 6h58.",
    },
    {
      id: "saint-luc",
      name: "Cabinet Saint-Luc",
      type: "Locaux professionnels · Saint-Michel",
      coords: [43.589, 1.4458],
      time: "7h00–9h00",
      worker: "Samir",
      status: "arrived",
      detail: "Arrivée enregistrée par QR code à 6h55.",
    },
    {
      id: "tilleuls",
      name: "Résidence Les Tilleuls",
      type: "Copropriété · Compans",
      coords: [43.6149, 1.4358],
      time: "7h00–9h00",
      worker: "Lina",
      status: "arrived",
      detail: "Arrivée enregistrée par QR code à 6h57.",
    },
  ];
  var scenarios = {
    absence: {
      target: "horizon",
      steps: [
        {
          clock: "7h42",
          title: "Une absence à gérer",
          copy: "Maria ne peut pas assurer son créneau à la Résidence Horizon.",
          event: "Absence signalée",
        },
        {
          clock: "7h43",
          title: "Léa propose le créneau",
          copy: "Léa propose le créneau aux salariés disponibles, dont Karima. Le site reste à couvrir tant que personne n’a accepté.",
          event: "Créneau proposé",
        },
        {
          clock: "7h46",
          title: "Karima accepte",
          copy: "Karima a accepté le créneau de 8h00 à 11h00. Le remplacement est confirmé, mais son arrivée n’est pas encore enregistrée.",
          event: "Remplacement confirmé",
        },
        {
          clock: "7h47",
          title: "Le message client attend l’accord du patron",
          copy: "Léa prépare le message et attend la validation du patron. Rien n’est encore envoyé dans cet exemple.",
          event: "Accord du patron attendu",
          preview:
            "Bonjour, Karima assurera la prestation à la Résidence Horizon de 8h00 à 11h00.",
        },
        {
          clock: "7h48",
          title: "Le patron valide le message",
          copy: "Dans cet exemple, le patron a donné son accord. Léa peut transmettre le message au client.",
          event: "Validation du patron dans l’exemple",
          approval: true,
          preview:
            "Bonjour, Karima assurera la prestation à la Résidence Horizon de 8h00 à 11h00.",
        },
        {
          clock: "7h48",
          title: "Le client est informé",
          copy: "Message envoyé dans cet exemple, après la validation du patron. Aucun message réel n’est envoyé.",
          event: "Envoi simulé après validation",
        },
      ],
    },
    retard: {
      target: "carmes",
      steps: [
        {
          clock: "8h02",
          title: "Un retard signalé",
          copy: "Noah a signalé 20 minutes de retard au commerce des Carmes. Aucune arrivée n’est encore enregistrée.",
          event: "Retard de 20 minutes",
        },
        {
          clock: "8h03",
          title: "Le patron est prévenu",
          copy: "Léa informe le patron du retard de Noah. Le site reste indiqué « Retard signalé ».",
          event: "Patron informé",
        },
        {
          clock: "8h04",
          title: "Un message prêt pour le client",
          copy: "Léa prépare un message pour le client et attend l’accord du patron. Aucun message réel ne sera envoyé.",
          event: "Accord du patron attendu",
          preview:
            "Bonjour, la prestation au commerce des Carmes commencera avec 20 minutes de retard.",
        },
        {
          clock: "8h04",
          title: "Le patron valide le message",
          copy: "Dans cet exemple, le patron a donné son accord. Léa peut transmettre le message au client.",
          event: "Validation du patron dans l’exemple",
          approval: true,
          preview:
            "Bonjour, la prestation au commerce des Carmes commencera avec 20 minutes de retard.",
        },
        {
          clock: "8h04",
          title: "Le client est informé",
          copy: "Message envoyé dans cet exemple, après la validation du patron. Aucun message réel n’est envoyé. Le site reste indiqué « Retard signalé » : aucun pointage n’a été enregistré.",
          event: "Envoi simulé après validation",
        },
      ],
    },
    pointage: {
      target: "martin",
      steps: [
        {
          clock: "7h57",
          title: "La prestation va commencer",
          copy: "Aïcha est attendue à 8h00 chez Martin. Aucun pointage n’est encore enregistré.",
          event: "Prestation prévue à 8h00",
        },
        {
          clock: "7h58",
          title: "Arrivée enregistrée",
          copy: "Aïcha confirme son arrivée chez Martin avec le QR code du site à 7h58.",
          event: "Pointage QR à 7h58",
        },
        {
          clock: "8h00",
          title: "L’information rejoint le point de 8h",
          copy: "Le patron retrouve l’arrivée d’Aïcha chez Martin dans son résumé. Le pointage vient du QR code, pas du GPS.",
          event: "Arrivée ajoutée au résumé",
        },
      ],
    },
  };
  var order = ["absence", "pointage", "retard"];
  var scenarioIndex = 0;
  var scenario = order[scenarioIndex];
  var phase = 0;
  var cycle = 0;
  var selected = "horizon";
  var sites = [];
  var playing = false;
  var timer = null;
  var resizeTimer = null;
  var generation = 0;
  var userPaused = motion.matches;
  var pageHidden = false;
  var inView = false;
  var mapVisible = false;
  var nearView = false;
  var map = null;
  var mapWidth = 0;
  var mapHeight = 0;
  var markers = new Map();
  var leafletPromise = null;
  var loading = false;
  var loadFailed = false;
  var siteEntries = Array.from(root.querySelectorAll("[data-map-site]"));
  var scenarioEntries = Array.from(
    root.querySelectorAll("[data-map-scenario]"),
  );

  function text(name, value) {
    var node = find(name);
    if (node) node.textContent = value;
  }

  function currentStep() {
    return scenarios[scenario].steps[phase];
  }
  function controls() {
    root.dataset.playing = String(playing);
    if (playButton) {
      playButton.textContent = playing
        ? "Mettre en pause"
        : "Reprendre l’animation";
      playButton.setAttribute("aria-label", playButton.textContent);
    }
  }

  function renderSites() {
    sites.forEach(function (site) {
      var state = states[site.status];
      var active = site.id === selected;
      siteEntries
        .filter(function (entry) {
          return entry.dataset.mapSite === site.id;
        })
        .forEach(function (entry) {
          if (active) entry.setAttribute("aria-current", "true");
          else entry.removeAttribute("aria-current");
          entry.dataset.state = site.status;
          var label = entry.querySelector("[data-site-status]");
          if (label) label.textContent = state.glyph + " " + state.label;
        });
      var marker = markers.get(site.id);
      if (!marker) return;
      var element = marker.getElement();
      if (!element) return;
      element.classList.toggle("is-selected", active);
      element.classList.toggle(
        "is-working",
        playing && site.id === scenarios[scenario].target,
      );
      var pin = element.querySelector(".demo-pin");
      pin.dataset.state = site.status;
      pin.style.setProperty("--pin-color", state.color);
      pin.classList.toggle("is-selected", active);
      pin.classList.toggle(
        "is-working",
        playing && site.id === scenarios[scenario].target,
      );
      var core = pin.querySelector(".demo-pin-core");
      core.textContent = state.glyph;
      core.style.backgroundColor = state.color;
      core.style.color = "#ffffff";
      marker.setZIndexOffset(active ? 1000 : 0);
    });
    var site = sites.find(function (item) {
      return item.id === selected;
    });
    var state = states[site.status];
    root.dataset.mapSelected = selected;
    text("title", site.name);
    text("kind", site.type);
    text("badge", state.glyph + " " + state.label);
    var badge = find("badge");
    if (badge) badge.dataset.state = site.status;
    text("shift", site.time);
    text("person", site.worker);
    text("detail", site.detail);
    ["uncovered", "late", "arrived"].forEach(function (status) {
      text(
        status,
        String(
          sites.filter(function (item) {
            return item.status === status;
          }).length,
        ),
      );
    });
  }

  function render(announce) {
    // Facts persist through this morning's sequence, then reset with the whole loop.
    sites = baseline.map(function (site) {
      return Object.assign({}, site);
    });
    if (scenarioIndex > 0 || phase >= 2) {
      Object.assign(sites[0], {
        status: "replaced",
        worker: "Karima",
        detail:
          "Karima a accepté le créneau de 8h00 à 11h00. Aucune arrivée enregistrée pour le moment.",
      });
    }
    if (scenarioIndex > 1 || (scenario === "pointage" && phase >= 1)) {
      Object.assign(sites[1], {
        status: "arrived",
        detail: "Arrivée enregistrée par QR code à 7h58.",
      });
    }
    if (scenario === "retard" && phase >= 1) {
      sites[2].detail =
        "Noah a signalé 20 minutes de retard. Le patron est informé. Aucune arrivée enregistrée pour le moment.";
    }
    var step = currentStep();
    root.dataset.scenario = scenario;
    root.dataset.phase = String(phase);
    root.dataset.cycle = String(cycle);
    text("cycle", String(cycle + 1));
    text("clock", step.clock);
    text("action-title", step.title);
    text("action-copy", step.copy);
    text("step", String(phase + 1) + " / " + scenarios[scenario].steps.length);
    var preview = find("preview");
    if (preview) {
      preview.hidden = !step.preview;
      preview.textContent = step.preview || "";
    }
    var approval = find("approval");
    if (approval) {
      approval.hidden = !step.approval;
      approval.textContent = step.approval
        ? "Exemple : validation donnée par le patron"
        : "";
    }
    scenarioEntries.forEach(function (entry) {
      if (entry.dataset.mapScenario === scenario)
        entry.setAttribute("aria-current", "true");
      else entry.removeAttribute("aria-current");
    });
    var feed = find("feed");
    if (feed) {
      var fragment = document.createDocumentFragment();
      scenarios[scenario].steps.forEach(function (event, index) {
        var item = document.createElement("li");
        item.className = "map-event";
        item.classList.toggle("is-current", index === phase);
        item.classList.toggle("is-pending", index > phase);
        if (index === phase) item.setAttribute("aria-current", "step");
        var time = document.createElement(index > phase ? "span" : "time");
        time.className = "map-event-time";
        time.textContent = index > phase ? "À venir" : event.clock;
        var parts = event.clock.split("h");
        if (index <= phase)
          time.dateTime = parts[0].padStart(2, "0") + ":" + parts[1];
        var label = document.createElement("strong");
        label.textContent = event.event;
        var copy = document.createElement("p");
        copy.textContent = event.copy;
        item.append(time, label, copy);
        fragment.append(item);
      });
      feed.replaceChildren(fragment);
    }
    controls();
    renderSites();
    if (announce) text("live", step.clock + ". " + step.title + ".");
  }

  function syncPlayback() {
    var canPlay = inView && !document.hidden && !pageHidden && !userPaused;
    if (!canPlay) {
      generation += 1;
      window.clearTimeout(timer);
      timer = null;
    } else if (timer === null) {
      var token = generation;
      timer = window.setTimeout(function () {
        if (token !== generation) return;
        timer = null;
        if (!inView || document.hidden || pageHidden || userPaused) {
          syncPlayback();
          return;
        }
        phase += 1;
        if (phase === scenarios[scenario].steps.length) {
          phase = 0;
          scenarioIndex = (scenarioIndex + 1) % order.length;
          if (scenarioIndex === 0) cycle += 1;
          scenario = order[scenarioIndex];
          selected = scenarios[scenario].target;
        }
        syncPlayback();
        render(true);
      }, 4000);
    }
    playing = timer !== null;
    controls();
    renderSites();
  }

  if (playButton) {
    playButton.addEventListener("click", function () {
      userPaused = playing;
      syncPlayback();
    });
    playButton.disabled = false;
  }

  function mapStatus(message) {
    if (statusNode) {
      if (statusNode.textContent !== message) statusNode.textContent = message;
      statusNode.hidden = !message;
    }
  }

  function leaflet() {
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      var stylesheet = document.createElement("link");
      var remaining = 2;
      var failed = false;
      script.src = "vendor/leaflet/leaflet.js";
      script.async = true;
      stylesheet.rel = "stylesheet";
      stylesheet.href = "vendor/leaflet/leaflet.css";
      function fail() {
        failed = true;
        script.onload = script.onerror = null;
        stylesheet.onload = stylesheet.onerror = null;
        script.remove();
        stylesheet.remove();
        reject(new Error("Chargement de Leaflet impossible"));
      }
      function loaded() {
        if (failed) return;
        remaining -= 1;
        if (remaining !== 0) return;
        script.onload = script.onerror = null;
        stylesheet.onload = stylesheet.onerror = null;
        if (window.L && typeof window.L.map === "function") resolve(window.L);
        else fail();
      }
      script.onload = stylesheet.onload = loaded;
      script.onerror = stylesheet.onerror = fail;
      document.head.append(stylesheet, script);
    });
    return leafletPromise;
  }

  function fitSites() {
    if (!map) return;
    map.fitBounds(
      baseline.map(function (site) {
        return site.coords;
      }),
      { padding: [36, 46], maxZoom: 13, animate: false },
    );
    mapWidth = mapNode.clientWidth;
    mapHeight = mapNode.clientHeight;
  }

  function createMap(L) {
    if (map || !mapNode || document.hidden || pageHidden || !mapVisible) return;
    map = L.map(mapNode, {
      zoomControl: false,
      attributionControl: true,
      trackResize: false,
      dragging: false,
      touchZoom: false,
      tapHold: false,
      doubleClickZoom: false,
      scrollWheelZoom: false,
      keyboard: false,
      boxZoom: false,
      zoomAnimation: false,
      fadeAnimation: false,
      markerZoomAnimation: false,
    });
    map.attributionControl.setPrefix(false);
    // Marker elements exist only after Leaflet has its initial view.
    fitSites();
    baseline.forEach(function (site) {
      var pin = document.createElement("span");
      pin.className = "demo-pin";
      pin.setAttribute("aria-hidden", "true");
      var core = document.createElement("span");
      core.className = "demo-pin-core";
      var name = document.createElement("span");
      name.className = "demo-pin-name";
      name.textContent = site.name;
      pin.append(core, name);
      var marker = L.marker(site.coords, {
        icon: L.divIcon({
          html: pin,
          className: "demo-marker",
          iconSize: [44, 44],
          iconAnchor: [22, 22],
        }),
        interactive: false,
        keyboard: false,
        autoPanOnFocus: false,
      }).addTo(map);
      markers.set(site.id, marker);
      var element = marker.getElement();
      element.setAttribute("aria-hidden", "true");
    });
    renderSites();
    var tileUrl = mapNode.dataset.tileUrl;
    if (tileUrl) {
      // Only Leaflet's visible viewport requests tiles; no warming or cache busting.
      var tiles = L.tileLayer(tileUrl, {
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
        crossOrigin: true,
        maxZoom: 19,
        keepBuffer: 0,
        updateWhenIdle: true,
        updateWhenZooming: false,
      });
      var failedTiles = new Set();
      tiles.on("tileerror", function (event) {
        failedTiles.add(event.tile);
      });
      tiles.on("tileload tileunload", function (event) {
        failedTiles.delete(event.tile);
      });
      tiles.on("load", function () {
        mapStatus(
          failedTiles.size
            ? "Le fond de carte est partiellement ou totalement indisponible. Les sites et la démonstration restent lisibles."
            : "",
        );
      });
      tiles.addTo(map);
    } else {
      mapStatus(
        "Le fond de carte est indisponible. Retrouvez les six sites sur la carte et dans la liste.",
      );
    }
  }

  function loadMap() {
    if (
      !mapNode ||
      map ||
      loading ||
      loadFailed ||
      document.hidden ||
      pageHidden ||
      !nearView
    )
      return;
    loading = true;
    mapStatus("Chargement de la carte… La liste des sites reste disponible.");
    leaflet()
      .then(function (L) {
        loading = false;
        createMap(L);
      })
      .catch(function () {
        loading = false;
        loadFailed = true;
        if (map) {
          try {
            map.remove();
          } catch (_) {
            /* Retain the independent list if Leaflet cleanup fails. */
          }
          map = null;
        }
        markers.clear();
        mapStatus(
          "La carte n’a pas pu se charger. La liste des sites et les scénarios restent disponibles.",
        );
      });
  }

  function resize() {
    window.clearTimeout(resizeTimer);
    resizeTimer = null;
    if (document.hidden || pageHidden) return;
    resizeTimer = window.setTimeout(function () {
      resizeTimer = null;
      if (
        map &&
        !document.hidden &&
        !pageHidden &&
        mapVisible &&
        (mapWidth !== mapNode.clientWidth || mapHeight !== mapNode.clientHeight)
      ) {
        map.invalidateSize({ pan: false, animate: false });
        fitSites();
      }
    }, 150);
  }

  function motionChanged() {
    root.dataset.reducedMotion = String(motion.matches);
    if (motion.matches) userPaused = true;
    syncPlayback();
  }

  root.dataset.reducedMotion = String(motion.matches);
  render(false);
  if (motion.addEventListener) motion.addEventListener("change", motionChanged);

  if ("IntersectionObserver" in window) {
    var loadObserver = new IntersectionObserver(
      function (entries) {
        nearView = entries[0].isIntersecting;
        if (nearView) loadMap();
      },
      { rootMargin: "150px", threshold: 0 },
    );
    loadObserver.observe(mapNode || workspace);
    var mapObserver = new IntersectionObserver(
      function (entries) {
        mapVisible = entries[0].isIntersecting;
        if (mapVisible) {
          loadMap();
          resize();
        }
      },
      { threshold: 0 },
    );
    if (mapNode) mapObserver.observe(mapNode);
    var autoObserver = new IntersectionObserver(
      function (entries) {
        inView = entries[0].isIntersecting;
        if (inView) {
          loadMap();
          resize();
        }
        syncPlayback();
      },
      { threshold: 0 },
    );
    autoObserver.observe(workspace);
  } else {
    nearView = inView = mapVisible = true;
    loadMap();
    syncPlayback();
  }
  window.addEventListener("resize", resize);
  if ("ResizeObserver" in window && mapNode) {
    var resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mapNode);
  }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      window.clearTimeout(resizeTimer);
      resizeTimer = null;
    } else {
      loadMap();
      resize();
    }
    syncPlayback();
  });
  window.addEventListener("pagehide", function () {
    pageHidden = true;
    syncPlayback();
    window.clearTimeout(resizeTimer);
    resizeTimer = null;
  });
  window.addEventListener("pageshow", function () {
    pageHidden = false;
    loadMap();
    resize();
    syncPlayback();
  });
})();
