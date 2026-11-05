// Ruchée: progressive enhancement, without cookies, tracking or storage.
(function () {
  "use strict";

  function all(selector, root) {
    return Array.prototype.slice.call(
      (root || document).querySelectorAll(selector),
    );
  }

  var motionQuery = null;
  try {
    if (typeof window.matchMedia === "function") {
      motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    }
  } catch (error) {
    // Keep the complete, static illustration if motion preferences are unavailable.
  }
  var reduced = !motionQuery || motionQuery.matches;
  var supportsObserver = typeof window.IntersectionObserver === "function";

  // CSS owns the 16px entrance. Without an observer, content stays readable.
  var reveals = all("[data-reveal]");
  var revealObserver = null;
  if (supportsObserver && !reduced) {
    revealObserver = new window.IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-revealed");
          revealObserver.unobserve(entry.target);
        });
      },
      { threshold: 0 },
    );
    reveals.forEach(function (element) {
      element.classList.add("reveal-ready");
      revealObserver.observe(element);
    });
  }

  var scene = document.querySelector("[data-scene]");
  var toggle = document.querySelector("[data-motion-toggle]");
  var deck = scene && scene.querySelector("[data-phone-deck]");
  var phone = deck && deck.querySelector(".hero-phone.device");
  var phones = [];
  var cover = scene && scene.querySelector(".scene-cover");
  var avatar = scene && scene.querySelector(".scene-avatar");
  var cursor = scene && scene.querySelector(".scene-cursor");
  var sheet = scene && scene.querySelector(".scene-sheet");
  var confirm = scene && scene.querySelector(".scene-confirm");
  var toast = scene && scene.querySelector(".scene-toast");
  var hero = scene && scene.closest(".hero-visual");
  var scenarioControls = hero && hero.querySelector("[data-scenario-controls]");
  var scenarioButtons = scenarioControls
    ? all("button[data-scenario]", scenarioControls)
    : [];
  var scenarioStatus = hero && hero.querySelector("[data-scenario-status]");
  var scenarios = [
    {
      name: "Remplacement",
      title: "Maria ne viendra pas.",
      subtitle: "Résidence Horizon · Lyon",
      time: "5:45",
      cover: "images/nettoyage-bureau.webp",
      avatar: "images/avatar-maria.svg",
      image: "images/avatar-karima.svg",
      rows: [
        ["!", "Absence signalée", "Par un vocal à Léa, à 5h45"],
        ["◷", "6h00 à 9h00", "Le créneau à remplacer"],
        ["↗", "Léa prévient l'équipe", "Une proposition, pas des appels"],
      ],
      sheetTitle: "« Oui, je peux y aller. »",
      sheetDetail: "Karima accepte le créneau\nRésidence Horizon · 6h00 à 9h00",
      status: "✓ Remplacement confirmé",
      sheetNote: "Le patron est informé.",
      action: "Voir le remplacement",
      toastTitle: "Karima a accepté",
      toastDetail: "Karima · 6h00 à 9h00",
      note: "Pas de nouvel outil à apprendre.",
      description:
        "Maria signale son absence. Léa propose le créneau de 6h à 9h à l'équipe. Karima accepte. Le site est couvert et le patron est informé.",
    },
    {
      name: "Recrutement",
      title: "Karima a postulé.",
      subtitle: "Agente de nettoyage · Lyon 3e",
      time: "10:20",
      cover: "images/materiel-nettoyage.webp",
      avatar: "images/avatar-karima.svg",
      image: "images/avatar-karima.svg",
      rows: [
        ["✓", "Disponible le matin", "« De 6h à 11h en semaine. »"],
        ["✓", "Secteur Lyon 3e", "« Je peux m'y déplacer. »"],
        ["✗", "Pas le samedi", "« Je ne suis pas disponible. »"],
      ],
      sheetTitle: "Les réponses sont réunies.",
      sheetDetail:
        "Chaque réponse reste visible.\nVous choisissez qui rencontrer.",
      status: "À lire par le patron",
      sheetNote: "Ni note, ni rejet automatique.",
      action: "Voir le dossier",
      toastTitle: "Dossier prêt à lire",
      toastDetail: "La décision reste la vôtre",
      note: "Léa collecte, vous décidez.",
      description:
        "Léa réunit les réponses de Karima, disponible le matin à Lyon 3e, mais pas le samedi. Ni note, ni rejet automatique : le patron choisit qui rencontrer.",
    },
    {
      name: "Consigne du patron",
      title: "« Préviens Martin : 15h. »",
      subtitle: "Votre consigne, par vocal",
      time: "14:10",
      cover: "images/nettoyage-logement.webp",
      avatar: "images/avatar-client.svg",
      image: "brand/ruchee-symbol.svg",
      rows: [
        ["◷", "Changement d'horaire", "Le client Martin, à 15h"],
        ["↗", "Message préparé", "Léa vous montre le texte"],
        ["!", "Votre accord d'abord", "Rien ne part sans confirmation"],
      ],
      sheetTitle: "Confirmez-vous ce message ?",
      sheetDetail: "« Bonjour, la prestation\ncommencera à 15h. »",
      status: "En attente de votre accord",
      sheetNote: "Destinataire : le client Martin.",
      action: "Confirmer l’envoi",
      toastTitle: "Consigne envoyée",
      toastDetail: "Après confirmation du patron",
      note: "Exemple : un accord avant chaque envoi.",
      description:
        "Le patron demande de prévenir le client Martin d'un changement d'horaire à 15h. Léa prépare le message. Le patron confirme, puis Léa l'envoie.",
    },
    {
      name: "Le point de 8h",
      title: "7 sites sur 8 couverts.",
      subtitle: "Le point de 8h",
      time: "8:00",
      cover: "images/nettoyage-miroir.webp",
      avatar: "brand/ruchee-symbol.svg",
      image: "brand/ruchee-symbol.svg",
      rows: [
        ["✓", "Maison Martin", "Karima est arrivée à 7h58"],
        ["!", "Bureaux Dupont", "Créneau encore à couvrir"],
        ["+", "2 nouveaux dossiers", "Les réponses sont réunies"],
      ],
      sheetTitle: "Le point de 8h est prêt",
      sheetDetail:
        "7 sites sur 8 couverts.\nBureaux Dupont : encore à couvrir.",
      status: "1 site à couvrir",
      attention: true,
      sheetNote: "Vous savez où intervenir.",
      action: "Lire le point de 8h",
      toastTitle: "Votre point est arrivé",
      toastDetail: "Prestations et candidatures",
      note: "Vous savez où intervenir.",
      description:
        "Le point de 8h : 7 prestations sur 8 couvertes. Karima est arrivée chez Martin à 7h58. Bureaux Dupont reste à couvrir. Deux nouveaux dossiers sont prêts à lire.",
    },
  ];
  var pairs = scene
    ? ["1", "2", "3"].map(function (id) {
        return {
          chip: scene.querySelector('.scene-chip[data-target="' + id + '"]'),
          row: scene.querySelector('.scene-row[data-row="' + id + '"]'),
        };
      })
    : [];
  var sceneSupported = !!(
    scene &&
    phone &&
    cover &&
    avatar &&
    cursor &&
    sheet &&
    confirm &&
    toast &&
    toggle &&
    !scene.contains(toggle) &&
    pairs.every(function (pair) {
      return pair.chip && pair.row;
    })
  );
  var timers = [];
  var generation = 0;
  var phase = "idle";
  var autoplay = true;
  var scenarioIndex = 0;
  var sceneVisible = false;

  function setSceneText(selector, value, root) {
    var element = (root || scene).querySelector(selector);
    if (element) element.textContent = value;
  }

  function fillPhone(element, config) {
    setSceneText("[data-scene-title]", config.title, element);
    setSceneText("[data-scene-subtitle]", config.subtitle, element);
    setSceneText("[data-scene-time]", config.time, element);
    setSceneText("[data-scene-action]", config.action, element);
    setSceneText("[data-scene-note]", config.note, element);
    setSceneText("[data-sheet-title]", config.sheetTitle, element);
    setSceneText("[data-sheet-detail]", config.sheetDetail, element);
    setSceneText("[data-sheet-status]", config.status, element);
    setSceneText("[data-sheet-note]", config.sheetNote, element);
    var status = element.querySelector("[data-sheet-status]");
    if (status) status.classList.toggle("is-attention", !!config.attention);
    element.querySelector(".scene-cover").setAttribute("src", config.cover);
    element.querySelector(".scene-avatar").setAttribute("src", config.avatar);
    element
      .querySelector(".scene-sheet > img")
      .setAttribute("src", config.image);
    config.rows.forEach(function (row, index) {
      var target = element.querySelector(
        '.scene-row[data-row="' + (index + 1) + '"]',
      );
      setSceneText(".row-icon", row[0], target);
      setSceneText("b", row[1], target);
      setSceneText("small", row[2], target);
      target.classList.add("is-filled");
    });
    all(".scene-cover, .scene-avatar", element).forEach(function (part) {
      part.classList.add("is-visible");
    });
  }

  function renderScenario() {
    var config = scenarios[scenarioIndex];
    phone = phones[scenarioIndex];
    cover = phone.querySelector(".scene-cover");
    avatar = phone.querySelector(".scene-avatar");
    sheet = phone.querySelector(".scene-sheet");
    confirm = phone.querySelector(".scene-confirm");
    scene.setAttribute("data-scenario-index", String(scenarioIndex));
    scene.setAttribute("aria-label", "Exemple fictif : " + config.description);
    phones.forEach(function (element, index) {
      var offset = (index - scenarioIndex + phones.length) % phones.length;
      element.classList.toggle("is-active", offset === 0);
      element.classList.toggle("is-next", offset === 1);
      element.classList.toggle("is-back", offset === 2);
      element.classList.toggle("is-previous", offset === 3);
      element.setAttribute("aria-hidden", String(offset !== 0));
      element.toggleAttribute("inert", offset !== 0);
    });
    setSceneText("[data-toast-title]", config.toastTitle);
    setSceneText("[data-toast-detail]", config.toastDetail);
    toast.querySelector(":scope > img").setAttribute("src", config.image);
    pairs.forEach(function (pair, index) {
      pair.row = phone.querySelector(
        '.scene-row[data-row="' + (index + 1) + '"]',
      );
      var row = config.rows[index];
      setSceneText("[data-chip-label]", row[1], pair.chip);
      setSceneText("[data-chip-icon]", row[0], pair.chip);
      if (index === 0) {
        pair.chip.querySelector("img").setAttribute("src", config.avatar);
      }
    });
    scenarioButtons.forEach(function (button) {
      button.setAttribute(
        "aria-pressed",
        String(Number(button.getAttribute("data-scenario")) === scenarioIndex),
      );
    });
    if (scenarioControls) {
      setSceneText(
        "[data-carousel-count]",
        "0" + (scenarioIndex + 1) + " / 0" + scenarios.length,
        scenarioControls,
      );
      setSceneText("[data-carousel-name]", config.name, scenarioControls);
    }
    if (scenarioStatus) {
      scenarioStatus.textContent =
        "Scénario " + (scenarioIndex + 1) + " sur 4 : " + config.name;
    }
  }

  function updateToggle() {
    if (!toggle) return;
    toggle.hidden = !sceneSupported || reduced;
    toggle.textContent =
      phase !== "idle" ? "Arrêter le défilement" : "Relancer le défilement";
  }

  function clearScene() {
    generation += 1;
    timers.forEach(function (timer) {
      window.clearTimeout(timer);
    });
    timers = [];
    if (!sceneSupported) return;
    scene.classList.remove("is-playing", "is-travelling");
    // Complete the old phone before renderScenario changes the active references.
    cover.classList.add("is-visible");
    avatar.classList.add("is-visible");
    [cursor, toast].forEach(function (element) {
      element.classList.remove("is-visible");
    });
    cursor.classList.remove("is-down");
    cursor.style.removeProperty("--x");
    cursor.style.removeProperty("--y");
    sheet.classList.remove("is-open");
    confirm.classList.remove("is-pressed");
    pairs.forEach(function (pair) {
      pair.row.classList.add("is-filled");
      pair.chip.classList.remove("is-visible", "is-held", "is-dropped");
      pair.chip.style.removeProperty("--x");
      pair.chip.style.removeProperty("--y");
    });
  }

  function completeScene() {
    clearScene();
    phase = "idle";
    updateToggle();
  }

  function at(delay, action) {
    var currentGeneration = generation;
    timers.push(
      window.setTimeout(function () {
        if (currentGeneration === generation) action();
      }, delay),
    );
  }

  // Convert nested phone geometry into the stage's local, unscaled coordinates.
  function center(element) {
    var stageRect = scene.getBoundingClientRect();
    var rect = element.getBoundingClientRect();
    var scaleX = stageRect.width / scene.offsetWidth || 1;
    var scaleY = stageRect.height / scene.offsetHeight || 1;
    return {
      x:
        (rect.left + rect.width / 2 - stageRect.left) / scaleX -
        scene.clientLeft,
      y:
        (rect.top + rect.height / 2 - stageRect.top) / scaleY - scene.clientTop,
    };
  }

  function position(element, point) {
    element.style.setProperty("--x", point.x - element.offsetLeft + "px");
    element.style.setProperty("--y", point.y - element.offsetTop + "px");
  }

  function playScene(explicit) {
    if (!sceneSupported || reduced || document.hidden) return;
    if (!sceneVisible && !explicit) return;
    clearScene();
    cover.classList.remove("is-visible");
    avatar.classList.remove("is-visible");
    pairs.forEach(function (pair) {
      pair.row.classList.remove("is-filled");
    });
    phase = "playing";
    scene.classList.add("is-playing");
    updateToggle();
    at(350, function () {
      cover.classList.add("is-visible");
    });
    at(950, function () {
      avatar.classList.add("is-visible");
    });

    pairs.forEach(function (pair, index) {
      var start = 1550 + index * 1500;
      var origin;
      at(start, function () {
        var maxX = Math.max(0, scene.clientWidth - pair.chip.offsetWidth);
        var maxY = Math.max(0, scene.clientHeight - pair.chip.offsetHeight);
        origin = {
          x: Math.min(
            maxX,
            Math.max(0, scene.clientWidth * (index === 1 ? 0.72 : 0.06)),
          ),
          y: Math.min(
            maxY,
            Math.max(0, scene.clientHeight * (0.22 + index * 0.22)),
          ),
        };
        // Place the hidden chip before fading it in; only its drag should travel.
        pair.chip.style.transition = "none";
        position(pair.chip, origin);
        void pair.chip.offsetWidth;
        pair.chip.style.removeProperty("transition");
        pair.chip.classList.add("is-visible");
      });
      at(start + 120, function () {
        position(cursor, {
          x: origin.x + pair.chip.offsetWidth / 2,
          y: origin.y + pair.chip.offsetHeight / 2,
        });
        cursor.classList.add("is-visible");
      });
      at(start + 700, function () {
        cursor.classList.add("is-down");
        pair.chip.classList.add("is-held");
      });
      at(start + 820, function () {
        var destination = center(pair.row);
        position(pair.chip, {
          x: destination.x - pair.chip.offsetWidth / 2,
          y: destination.y - pair.chip.offsetHeight / 2,
        });
        position(cursor, destination);
      });
      at(start + 1440, function () {
        cursor.classList.remove("is-down");
        pair.chip.classList.remove("is-held");
        pair.chip.classList.add("is-dropped");
        pair.row.classList.add("is-filled");
      });
    });

    at(6800, function () {
      cursor.classList.remove("is-visible");
      sheet.classList.add("is-open");
    });
    at(9600, function () {
      sheet.classList.remove("is-open");
    });
    at(10200, function () {
      position(cursor, center(confirm));
      cursor.classList.add("is-visible");
    });
    at(10750, function () {
      cursor.classList.add("is-down");
      confirm.classList.add("is-pressed");
    });
    at(10950, function () {
      cursor.classList.remove("is-down");
      confirm.classList.remove("is-pressed");
      toast.classList.add("is-visible");
    });
    at(15450, function () {
      completeScene();
      if (!autoplay || reduced || document.hidden || !sceneVisible) return;
      selectScenario((scenarioIndex + 1) % scenarios.length, false);
    });
  }

  function selectScenario(index, explicit) {
    if (!Number.isInteger(index) || !scenarios[index]) return;
    if (explicit) autoplay = false;
    var travelling = index !== scenarioIndex || phase === "travelling";
    completeScene();
    scenarioIndex = index;
    renderScenario();
    if (explicit && !sceneVisible && !document.hidden) {
      scene.scrollIntoView({ block: "center", behavior: "instant" });
    }
    if (reduced || document.hidden || (!explicit && !sceneVisible)) return;
    if (!travelling) {
      playScene(explicit);
      return;
    }
    phase = "travelling";
    scene.classList.add("is-travelling");
    updateToggle();
    at(700, function () {
      completeScene();
      playScene(explicit && !supportsObserver);
    });
  }

  updateToggle();
  if (sceneSupported) {
    // Clone the untouched template once; phone content never changes on navigation.
    scenarios.forEach(function (config, index) {
      var element = index === 0 ? phone : phone.cloneNode(true);
      element.setAttribute("data-phone", String(index));
      phones.push(element);
      if (index !== 0) deck.appendChild(element);
    });
    phones.forEach(function (element, index) {
      fillPhone(element, scenarios[index]);
    });
    renderScenario();
    scene.classList.add("has-carousel");
    if (hero) {
      hero.addEventListener("focusin", function (event) {
        if (
          !toggle.contains(event.target) &&
          !(scenarioControls && scenarioControls.contains(event.target))
        )
          return;
        autoplay = false;
        // Keep the active phase until the click: focusing Stop must not turn it into Play.
      });
    }
    toggle.addEventListener("click", function () {
      if (phase !== "idle") {
        autoplay = false;
        completeScene();
      } else {
        autoplay = true;
        if (!sceneVisible && !document.hidden) {
          scene.scrollIntoView({ block: "center", behavior: "instant" });
        }
        playScene(true);
      }
    });
    scenarioButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        selectScenario(Number(button.getAttribute("data-scenario")), true);
      });
    });
    if (scenarioControls) {
      all("button[data-carousel-step]", scenarioControls).forEach(
        function (button) {
          button.addEventListener("click", function () {
            var step = Number(button.getAttribute("data-carousel-step"));
            if (step !== -1 && step !== 1) return;
            selectScenario(
              (scenarioIndex + step + scenarios.length) % scenarios.length,
              true,
            );
          });
        },
      );
      scenarioControls.addEventListener("keydown", function (event) {
        var index = scenarioIndex;
        if (event.key === "ArrowLeft") index -= 1;
        else if (event.key === "ArrowRight") index += 1;
        else if (event.key === "Home") index = 0;
        else if (event.key === "End") index = scenarios.length - 1;
        else return;
        event.preventDefault();
        index = (index + scenarios.length) % scenarios.length;
        selectScenario(index, true);
        var button = scenarioControls.querySelector(
          '[data-scenario="' + index + '"]',
        );
        if (button) button.focus({ preventScroll: true });
      });
      scenarioControls.hidden = false;
    }
    if (supportsObserver) {
      new window.IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            sceneVisible =
              entry.isIntersecting && entry.intersectionRatio >= 0.3;
            if (!sceneVisible) {
              completeScene();
            } else if (autoplay && phase === "idle") {
              playScene();
            }
          });
        },
        { threshold: [0, 0.3] },
      ).observe(scene);
    }
    window.addEventListener("resize", function () {
      completeScene();
      if (autoplay && !reduced && !document.hidden && sceneVisible) {
        phase = "resizing";
        updateToggle();
        at(180, function () {
          if (autoplay) playScene();
          else completeScene();
        });
      }
    });
  }

  var miniScenes = all("[data-mini-scene]").map(function (element) {
    return { element: element, visible: false };
  });
  function updateMiniScenes() {
    miniScenes.forEach(function (mini) {
      mini.element.classList.toggle(
        "is-active",
        mini.visible && !reduced && !document.hidden,
      );
    });
  }
  if (supportsObserver) {
    var miniObserver = new window.IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          miniScenes.forEach(function (mini) {
            if (mini.element === entry.target) {
              mini.visible =
                entry.isIntersecting && entry.intersectionRatio >= 0.5;
            }
          });
        });
        updateMiniScenes();
      },
      { threshold: [0, 0.5] },
    );
    miniScenes.forEach(function (mini) {
      miniObserver.observe(mini.element);
    });
  }

  function motionChanged() {
    reduced = motionQuery.matches;
    if (reduced) {
      completeScene();
      if (revealObserver) revealObserver.disconnect();
      reveals.forEach(function (element) {
        element.classList.remove("reveal-ready");
        element.classList.add("is-revealed");
      });
    } else if (autoplay && phase === "idle") {
      playScene();
    }
    updateToggle();
    updateMiniScenes();
  }
  if (motionQuery) {
    if (typeof motionQuery.addEventListener === "function") {
      motionQuery.addEventListener("change", motionChanged);
    } else if (typeof motionQuery.addListener === "function") {
      motionQuery.addListener(motionChanged);
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      completeScene();
    } else if (autoplay && phase === "idle") {
      playScene();
    }
    updateMiniScenes();
  });

  var bubble = document.getElementById("lang-bubble");
  var texts = {
    fr: "Demain, vous travaillez de 6h00 à 9h00 à la Tour Horizon. Le badge est à l'accueil.",
    pt: "Amanhã trabalha das 6h00 às 9h00 na Torre Horizon. O crachá está na receção.",
    es: "Mañana trabaja de 6:00 a 9:00 en la Torre Horizon. La tarjeta está en recepción.",
    ar: "عملك غدًا من الساعة 6:00 إلى 9:00 في برج هورايزون. البطاقة عند الاستقبال.",
    en: "Tomorrow you work from 6:00 to 9:00 at Tour Horizon. The badge is at reception.",
  };
  var langs = all(".lang-switch button[data-lang]");
  langs.forEach(function (button) {
    button.addEventListener("click", function () {
      var lang = button.getAttribute("data-lang");
      if (!bubble || !Object.prototype.hasOwnProperty.call(texts, lang)) return;
      langs.forEach(function (other) {
        other.setAttribute("aria-pressed", String(other === button));
      });
      bubble.textContent = texts[lang];
      bubble.setAttribute("lang", lang === "pt" ? "pt-PT" : lang);
      if (lang === "ar") bubble.setAttribute("dir", "rtl");
      else bubble.removeAttribute("dir");
    });
  });

  var menuToggle = document.querySelector("[data-menu-toggle]");
  if (bubble) {
    all(".lang-switch").forEach(function (group) {
      group.hidden = false;
    });
  }
  var menu = document.getElementById("site-menu");
  if (menuToggle && menu) {
    function closeMenu() {
      menuToggle.setAttribute("aria-expanded", "false");
      menu.classList.remove("is-open");
    }
    closeMenu();
    menuToggle.setAttribute("aria-controls", "site-menu");
    menuToggle.hidden = false;
    menuToggle.addEventListener("click", function () {
      var open = menuToggle.getAttribute("aria-expanded") !== "true";
      menuToggle.setAttribute("aria-expanded", String(open));
      menu.classList.toggle("is-open", open);
    });
    document.addEventListener("keydown", function (event) {
      if (
        event.key !== "Escape" ||
        menuToggle.getAttribute("aria-expanded") !== "true"
      )
        return;
      closeMenu();
      menuToggle.focus();
    });
    menu.addEventListener("click", function (event) {
      if (event.target instanceof Element && event.target.closest("a[href]"))
        closeMenu();
    });
  }
})();
