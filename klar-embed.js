/* klar-embed.js — the drop-in ordering + booking surface for a Klar client site.
 *
 * One file, no build step, no dependencies. Copy it into the site (static sites:
 * next to index.html; Next.js: public/) and add ONE element:
 *
 *   <div data-klar-slug="ravintola-ani" data-klar-phone="09 622 2797"></div>
 *   <script src="/klar-embed.js" defer></script>
 *
 * It generalises the hand-built surface in sites/ravintola-ani/index.html, which
 * is wired to that site's element ids and Finnish copy. Nothing here is
 * per-restaurant: the slug, the surfaces, the phone number and the language all
 * come off the mount element.
 *
 * Public API it talks to (apps/booking):
 *   GET  /api/<orderSlug>/menu           orderable menu; item ids the server prices from
 *   POST /api/<orderSlug>/order          places the order (Idempotency-Key header)
 *   GET  /api/<bookSlug>/availability    real free slots for a date + party size
 *   POST /api/<bookSlug>/book            creates the booking
 *
 * TWO KEYSPACES, DELIBERATELY. Ordering is keyed by the console's clients.slug;
 * booking is keyed by booking's restaurants.slug. They are usually equal
 * (ravintola-ani) but not always — 16 Boom is "boom16" for ordering and
 * "boom-16" for booking. data-klar-slug sets both; data-klar-order-slug and
 * data-klar-book-slug override one side. Crossing them 404s both surfaces.
 *
 * Prices are never sent from the browser. The server prices the order from the
 * database by menu-item id and returns the total.
 *
 * CORS: the API answers a cross-origin request only for an origin on its
 * per-slug allowlist (apps/booking/src/lib/cors.ts). A newly wired site fetches
 * nothing until an operator adds its production origin there. When that has not
 * happened the embed shows its unavailable panel and logs the reason — it never
 * renders an empty box.
 *
 * HOST-MENU MODE — data-klar-menu="host". A site that already has a designed
 * menu section must not grow a second one: the embed then renders the cart and
 * checkout ONLY, and the site's own markup does the adding. The contract is
 * four DOM events on the mount element (all bubble, so document works too):
 *
 *   klar:menu         out  { categories, currency, allowsEatIn, client }
 *   klar:menu-failed  out  { reason }            the surface is dark; hide buttons
 *   klar:cart         out  { lines, count, totalCents, currency }
 *   klar:add          in   { id, qty }           qty defaults 1, may be negative
 *   klar:sync         in   —  (on document) re-emits the last menu and cart
 *
 * klar:sync exists because the host's listener and the embed's fetch race: a
 * host that mounts late asks for a replay instead of waiting forever. An id the
 * loaded menu does not carry is refused and logged — a host whose names have
 * drifted from the database gets a visibly missing button, never a silent one.
 *
 * Prices still come from the server in host-menu mode. The host sends ids.
 */
(function () {
  'use strict';

  var DEFAULT_API = 'https://booking.klarsystems.com';
  var LOCAL_API = 'http://localhost:3001';
  var PARTY_MAX_DEFAULT = 12;
  var BOOKING_HORIZON_DAYS = 90; /* the API's ceiling */

  /* ---------------------------------------------------------------- copy --- */

  var COPY = {
    fi: {
      tabOrder: 'Tilaa',
      tabBook: 'Varaa pöytä',
      cartTitle: 'Tilauksesi',
      cartEmpty: 'Tilauksesi on tyhjä. Valitse ruokalistalta.',
      add: '+ Lisää',
      addMore: 'Lisää',
      eatIn: 'Syön täällä',
      takeaway: 'Nouto',
      name: 'Nimi',
      namePlaceholder: 'Nimi tilausta varten',
      phone: 'Puhelin',
      optional: '(vapaaehtoinen)',
      total: 'Yhteensä',
      send: 'Lähetä tilaus',
      sending: 'Lähetetään…',
      payAtVenue: 'Maksu ravintolassa. Hinnat lasketaan palvelimella.',
      orderOk: 'Tilaus lähetetty',
      reference: 'Viite',
      collect: 'Nouto tiskiltä. Maksu ravintolassa.',
      table: 'Tuomme annokset pöytään. Maksu ravintolassa.',
      orderAgain: 'Tilaa lisää',
      needName: 'Lisää nimi, jotta löydämme tilauksesi.',
      menuLoading: 'Ladataan ruokalistaa…',
      orderingOff: 'Verkkotilaus ei ole juuri nyt käytössä.',
      menuFailed: 'Ruokalistaa ei saatu ladattua. Päivitä sivu.',
      date: 'Päivä',
      party: 'Seurue',
      person: 'henkilö',
      people: 'henkilöä',
      time: 'Kellonaika',
      slotsLoading: 'Haetaan vapaita aikoja…',
      closed: 'Ravintola on suljettu tänä päivänä.',
      noSlots: 'Tälle päivälle ei ole vapaita aikoja. Kokeile toista päivää.',
      slotsFailed: 'Vapaita aikoja ei saatu haettua.',
      bookingOff: 'Pöytävaraus ei ole juuri nyt käytössä.',
      email: 'Sähköposti',
      requests: 'Toiveet',
      requestsPlaceholder: 'Korkea tuoli, ikkunapöytä, juhlat…',
      dietary: 'Allergiat tai erityisruokavalio',
      dietaryPlaceholder: 'Esim. pähkinäallergia, keliakia',
      /* MUST match HEALTH_CONSENT_TEXT.fi in
         apps/booking/src/lib/health-consent-text.ts — the server stores that
         constant as the consent_text, so if these two drift the record proves
         wording the guest never saw. A test asserts they are identical:
         apps/booking/src/lib/__tests__/health-consent.test.ts. */
      dietaryConsent:
        'Annan ravintolalle luvan käsitellä yllä kertomiani allergia- ja ' +
        'erityisruokavaliotietoja tätä varausta varten. Tiedot ovat terveystietoja. ' +
        'Ne näkyvät vain keittiölle ja salille, ne poistetaan varauksen jälkeen, ja ' +
        'voit poistaa ne itse milloin tahansa vahvistussähköpostin linkistä.',
      dietaryConsentMissing: 'Rastita suostumus, tai tyhjennä allergiakenttä.',
      book: 'Varaa pöytä',
      booking: 'Varataan…',
      bookOk: 'Pöytä varattu',
      bookConfirm: 'Vahvistus lähetettiin sähköpostiisi.',
      bookAgain: 'Tee uusi varaus',
      bookFields: 'Täytä päivä, kellonaika, nimi, puhelin ja sähköposti.',
      at: 'klo',
      generic: 'Yhteys ei onnistunut. Yritä hetken päästä uudelleen.',
      callUs: 'Soita',
      badPhone: 'Tarkista puhelinnumero (esim. +358 40 123 4567).',
      tooMany: 'Liikaa yrityksiä. Odota hetki ja yritä uudelleen.',
      codes: {
        ORDER_REJECTED: 'Jokin valitsemasi annos ei ole juuri nyt saatavilla. Poista se tilauksesta.',
        VALIDATION_ERROR: 'Tarkista tilauksen tiedot.',
        IDEMPOTENCY_CONFLICT: 'Tämä tilaus on jo lähetetty.',
        PAYLOAD_TOO_LARGE: 'Tilaus on liian suuri verkkotilaukseen.'
      }
    },
    en: {
      tabOrder: 'Order',
      tabBook: 'Book a table',
      cartTitle: 'Your order',
      cartEmpty: 'Your order is empty. Pick something from the menu.',
      add: '+ Add',
      addMore: 'Add',
      eatIn: 'Eat in',
      takeaway: 'Takeaway',
      name: 'Name',
      namePlaceholder: 'Name for the order',
      phone: 'Phone',
      optional: '(optional)',
      total: 'Total',
      send: 'Send order',
      sending: 'Sending…',
      payAtVenue: 'Pay at the restaurant. Prices are calculated on the server.',
      orderOk: 'Order sent',
      reference: 'Reference',
      collect: 'Collect at the counter. Pay at the restaurant.',
      table: 'We will bring it to your table. Pay at the restaurant.',
      orderAgain: 'Order more',
      needName: 'Add a name so we can find your order.',
      menuLoading: 'Loading the menu…',
      orderingOff: 'Online ordering is not available right now.',
      menuFailed: 'The menu could not be loaded. Please refresh the page.',
      date: 'Date',
      party: 'Party',
      person: 'person',
      people: 'people',
      time: 'Time',
      slotsLoading: 'Looking for free times…',
      closed: 'The restaurant is closed on this day.',
      noSlots: 'No free times on this day. Try another date.',
      slotsFailed: 'Free times could not be loaded.',
      bookingOff: 'Table booking is not available right now.',
      email: 'Email',
      requests: 'Requests',
      requestsPlaceholder: 'High chair, window table, a celebration…',
      dietary: 'Allergies or special diet',
      dietaryPlaceholder: 'E.g. nut allergy, coeliac',
      /* MUST match HEALTH_CONSENT_TEXT.en — see the Finnish note above. */
      dietaryConsent:
        'I allow the restaurant to process the allergy and special-diet information ' +
        'I have given above for this booking. This is health data. It is seen only ' +
        'by the kitchen and the floor, it is deleted after the visit, and you can ' +
        'delete it yourself at any time from the link in your confirmation email.',
      dietaryConsentMissing: 'Please tick the box, or clear the allergy field.',
      book: 'Book a table',
      booking: 'Booking…',
      bookOk: 'Table booked',
      bookConfirm: 'A confirmation was sent to your email.',
      bookAgain: 'Make another booking',
      bookFields: 'Fill in the date, time, name, phone and email.',
      at: 'at',
      generic: 'The connection failed. Please try again in a moment.',
      callUs: 'Call',
      badPhone: 'Check the phone number (e.g. +358 40 123 4567).',
      tooMany: 'Too many attempts. Wait a moment and try again.',
      codes: {
        ORDER_REJECTED: 'One of the dishes you picked is not available right now. Remove it from the order.',
        VALIDATION_ERROR: 'Check the order details.',
        IDEMPOTENCY_CONFLICT: 'This order has already been sent.',
        PAYLOAD_TOO_LARGE: 'The order is too large for online ordering.'
      }
    }
  };

  /* --------------------------------------------------------------- styles --- */

  var CSS = [
    '.klar-embed{--klar-accent:#111;--klar-on-accent:#fff;--klar-line:#e4e0d8;',
    '--klar-muted:#6b6357;--klar-radius:12px;color:inherit;font:inherit;text-align:left}',
    '.klar-embed *{box-sizing:border-box}',
    '.klar-tabs{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap}',
    '.klar-tabs button{flex:1 1 160px;padding:12px 16px;border:1px solid var(--klar-line);',
    'background:transparent;border-radius:var(--klar-radius);cursor:pointer;font:inherit;',
    'font-weight:600;color:inherit}',
    '.klar-tabs button.klar-on{background:var(--klar-accent);color:var(--klar-on-accent);',
    'border-color:var(--klar-accent)}',
    '.klar-panel{display:none}.klar-panel.klar-on{display:block}',
    '.klar-cats{display:flex;gap:8px;overflow-x:auto;padding-bottom:10px;margin-bottom:14px}',
    '.klar-cats button{white-space:nowrap;padding:8px 14px;border:1px solid var(--klar-line);',
    'background:transparent;border-radius:999px;cursor:pointer;font:inherit;color:inherit}',
    '.klar-cats button.klar-on{background:var(--klar-accent);color:var(--klar-on-accent);',
    'border-color:var(--klar-accent)}',
    '.klar-item{display:flex;gap:16px;justify-content:space-between;align-items:flex-start;',
    'padding:14px 0;border-bottom:1px solid var(--klar-line)}',
    '.klar-item h4{margin:0 0 4px;font-size:1rem}',
    '.klar-item p{margin:0;font-size:.875rem;color:var(--klar-muted)}',
    '.klar-side{display:flex;align-items:center;gap:12px;flex-shrink:0}',
    '.klar-price{font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.klar-add,.klar-btn{padding:9px 16px;border:0;border-radius:var(--klar-radius);',
    'background:var(--klar-accent);color:var(--klar-on-accent);cursor:pointer;font:inherit;',
    'font-weight:600}',
    '.klar-btn[disabled],.klar-add[disabled]{opacity:.55;cursor:default}',
    '.klar-btn-full{display:block;width:100%;margin-top:16px}',
    '.klar-cart{margin-top:22px;padding:18px;border:1px solid var(--klar-line);',
    'border-radius:var(--klar-radius)}',
    '.klar-cart h3{margin:0 0 12px;font-size:1rem}',
    '.klar-line{display:flex;align-items:center;gap:10px;justify-content:space-between;',
    'padding:8px 0}',
    '.klar-ln{flex:1 1 auto}.klar-lp{font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.klar-qty{display:flex;align-items:center;gap:8px}',
    '.klar-qty button{width:30px;height:30px;border:1px solid var(--klar-line);background:',
    'transparent;border-radius:8px;cursor:pointer;font:inherit;color:inherit;line-height:1}',
    '.klar-seg{display:flex;gap:8px;margin:14px 0}',
    '.klar-only-ful{margin:14px 0 0;font-size:.85rem;color:var(--klar-muted)}',
    '.klar-seg button{flex:1;padding:10px;border:1px solid var(--klar-line);background:',
    'transparent;border-radius:var(--klar-radius);cursor:pointer;font:inherit;color:inherit}',
    '.klar-seg button.klar-on{background:var(--klar-accent);color:var(--klar-on-accent);',
    'border-color:var(--klar-accent)}',
    '.klar-field{margin:12px 0}',
    /* The Art 9 consent row: a normal-case, wrapping paragraph beside a
       checkbox, deliberately unlike the uppercase field labels above — it is
       wording to be read, not a caption to be skimmed. */
    '.klar-consent{display:flex;align-items:flex-start;gap:8px;margin-top:8px;',
    'font-size:.75rem;line-height:1.45;text-transform:none;letter-spacing:0;',
    'font-weight:400;cursor:pointer}',
    '.klar-consent input{width:auto;margin-top:2px;flex:0 0 auto}',
    '.klar-consent[hidden]{display:none}',
    '.klar-field label{display:block;font-size:.75rem;text-transform:uppercase;',
    'letter-spacing:.08em;margin-bottom:6px;color:var(--klar-muted)}',
    '.klar-field input,.klar-field select,.klar-field textarea{width:100%;padding:11px 12px;',
    'border:1px solid var(--klar-line);border-radius:var(--klar-radius);font:inherit;',
    'background:transparent;color:inherit}',
    '.klar-total{display:flex;justify-content:space-between;align-items:baseline;',
    'margin-top:14px;font-weight:700}',
    '.klar-tv{font-size:1.25rem;font-variant-numeric:tabular-nums}',
    '.klar-slots{display:flex;flex-wrap:wrap;gap:8px;min-height:42px;align-items:center}',
    '.klar-slots button{padding:9px 14px;border:1px solid var(--klar-line);background:',
    'transparent;border-radius:var(--klar-radius);cursor:pointer;font:inherit;color:inherit}',
    '.klar-slots button.klar-on{background:var(--klar-accent);color:var(--klar-on-accent);',
    'border-color:var(--klar-accent)}',
    '.klar-slots button[disabled]{opacity:.35;cursor:default;text-decoration:line-through}',
    '.klar-muted{color:var(--klar-muted);font-size:.9rem}',
    '.klar-err{margin:12px 0 0;color:#a3341f;font-size:.9rem}',
    '.klar-note{margin:10px 0 0;font-size:.78rem;color:var(--klar-muted)}',
    '.klar-ok{text-align:center;padding:26px 0}',
    '.klar-check{font-size:2rem;line-height:1}',
    '.klar-big{font-size:1.5rem;font-weight:700;margin:10px 0}',
    '.klar-unavailable{padding:22px;border:1px solid var(--klar-line);',
    'border-radius:var(--klar-radius);text-align:center}'
  ].join('');

  var stylesInjected = false;
  function injectStyles(doc) {
    if (stylesInjected) return;
    stylesInjected = true;
    var style = doc.createElement('style');
    style.setAttribute('data-klar-embed', 'styles');
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  /* -------------------------------------------------------------- helpers --- */

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function money(cents, currency) {
    var amount = (cents / 100).toFixed(2);
    /* Finnish sites read a comma; everything else keeps the dot. */
    if (currency === 'EUR' || currency == null) return amount.replace('.', ',') + ' €';
    return amount + ' ' + currency;
  }

  function hhmm(value) {
    return String(value || '').slice(0, 5);
  }

  function warn(message, detail) {
    /* Every dark surface says why, in the console, with the slug in the text —
     * "it just doesn't show up" is the failure this prevents. */
    if (typeof console !== 'undefined' && console.error) {
      if (detail === undefined) console.error('[klar-embed] ' + message);
      else console.error('[klar-embed] ' + message, detail);
    }
  }

  function todayIn(timezone) {
    /* 'sv-SE' formats as YYYY-MM-DD. The API rejects a past date in the
     * restaurant's timezone, not the visitor's. */
    return new Date().toLocaleDateString('sv-SE', { timeZone: timezone });
  }

  function plusDays(iso, days) {
    var d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function newKey() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'klar-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function readJson(response) {
    return response
      .json()
      .catch(function () {
        return {};
      })
      .then(function (body) {
        return { ok: response.ok, status: response.status, body: body || {} };
      });
  }

  /* ---------------------------------------------------------------- config --- */

  function defaultApi(loc) {
    var host = loc && loc.hostname;
    /* Served from localhost the calls point at a local booking app on :3001,
     * which is also the only origin the API's CORS allowlist accepts outside
     * production. */
    return host === 'localhost' || host === '127.0.0.1' ? LOCAL_API : DEFAULT_API;
  }

  function readConfig(mount, loc) {
    var data = mount.dataset || {};
    var slug = (data.klarSlug || '').trim();
    var surfaces = (data.klarSurfaces || 'order book').toLowerCase();
    var locale = (data.klarLocale || 'fi').toLowerCase();
    var partyMax = parseInt(data.klarPartyMax || '', 10);
    return {
      orderSlug: (data.klarOrderSlug || slug).trim(),
      bookSlug: (data.klarBookSlug || slug).trim(),
      order: surfaces.indexOf('order') !== -1,
      book: surfaces.indexOf('book') !== -1,
      /* "host" = the page already renders the menu; the embed contributes the
         cart and checkout only. Anything else keeps the embed's own list. */
      hostMenu: (data.klarMenu || '').trim().toLowerCase() === 'host',
      api: (data.klarApi || defaultApi(loc)).replace(/\/$/, ''),
      phone: (data.klarPhone || '').trim(),
      timezone: (data.klarTimezone || 'Europe/Helsinki').trim(),
      partyMax: partyMax > 0 ? partyMax : PARTY_MAX_DEFAULT,
      copy: COPY[locale] || COPY.fi,
      locale: COPY[locale] ? locale : 'fi'
    };
  }

  /* ------------------------------------------------------------ the surface --- */

  function mountKlar(mount, win) {
    var doc = mount.ownerDocument;
    var cfg = readConfig(mount, win.location);
    var t = cfg.copy;

    injectStyles(doc);
    mount.classList.add('klar-embed');
    if (cfg.hostMenu) mount.classList.add('klar-host-menu');

    /* The host-menu contract. Bubbling so a host can listen on document rather
     * than having to find the mount element it did not render itself. */
    function emit(name, detail) {
      try {
        mount.dispatchEvent(new win.CustomEvent(name, { detail: detail, bubbles: true }));
      } catch (error) {
        warn('could not dispatch ' + name + '.', error);
      }
    }

    function callUs() {
      return cfg.phone ? ' ' + t.callUs + ' ' + cfg.phone + '.' : '';
    }

    function unavailable(message) {
      mount.innerHTML =
        '<div class="klar-unavailable"><p class="klar-muted">' +
        esc(message + callUs()) +
        '</p></div>';
    }

    if (!cfg.orderSlug && !cfg.bookSlug) {
      warn('mount has no data-klar-slug — nothing to fetch.', mount);
      unavailable(t.generic);
      return;
    }
    if (!cfg.order && !cfg.book) {
      warn('data-klar-surfaces "' + (mount.dataset.klarSurfaces || '') + '" enables neither surface.');
      unavailable(t.generic);
      return;
    }

    /* ---- shell ---- */
    var showTabs = cfg.order && cfg.book;
    mount.innerHTML =
      (showTabs
        ? '<div class="klar-tabs">' +
          '<button type="button" class="klar-on" data-klar-tab="order">' + esc(t.tabOrder) + '</button>' +
          '<button type="button" data-klar-tab="book">' + esc(t.tabBook) + '</button>' +
          '</div>'
        : '') +
      (cfg.order
        ? '<div class="klar-panel klar-on" data-klar-panel="order">' +
          '<div data-klar="order-live">' +
          '<div class="klar-cats" data-klar="cats" hidden></div>' +
          /* In host-menu mode the page is already showing the menu, so this
             slot starts empty and hidden. It is un-hidden only to carry the
             fail-closed "call us" panel. */
          (cfg.hostMenu
            ? '<div data-klar="items" hidden></div>'
            : '<div data-klar="items"><p class="klar-muted">' + esc(t.menuLoading) + '</p></div>') +
          '<div class="klar-cart" data-klar="cart"></div>' +
          '</div><div data-klar="order-ok" class="klar-ok" hidden></div></div>'
        : '') +
      (cfg.book
        ? '<div class="klar-panel' + (cfg.order ? '' : ' klar-on') + '" data-klar-panel="book">' +
          '<div data-klar="book-live">' +
          '<div class="klar-field"><label>' + esc(t.date) + '</label>' +
          '<input type="date" data-klar="date"></div>' +
          '<div class="klar-field"><label>' + esc(t.party) + '</label>' +
          '<select data-klar="party"></select></div>' +
          '<div class="klar-field"><label>' + esc(t.time) + '</label>' +
          '<div class="klar-slots" data-klar="slots"></div></div>' +
          '<div class="klar-field"><label>' + esc(t.name) + '</label>' +
          '<input type="text" autocomplete="name" data-klar="bname"></div>' +
          '<div class="klar-field"><label>' + esc(t.phone) + '</label>' +
          '<input type="tel" autocomplete="tel" data-klar="bphone"></div>' +
          '<div class="klar-field"><label>' + esc(t.email) + '</label>' +
          '<input type="email" autocomplete="email" data-klar="bemail"></div>' +
          '<div class="klar-field"><label>' + esc(t.requests) + '</label>' +
          '<textarea rows="2" data-klar="breq" placeholder="' + esc(t.requestsPlaceholder) + '"></textarea></div>' +
          /* The allergy field and its own consent tick, split from the requests
             box above for GDPR Art 9(2)(a): consent has to be specific to the
             health data, and a single box cannot tell "no nuts" from "high
             chair". The tick is hidden until the field has something in it, so
             a guest asking for a high chair is never asked to consent to
             health processing. The server refuses the write without it. */
          '<div class="klar-field"><label>' + esc(t.dietary) + '</label>' +
          '<textarea rows="2" data-klar="bdiet" placeholder="' + esc(t.dietaryPlaceholder) + '"></textarea>' +
          '<label class="klar-consent" data-klar="bdiet-consent-row" hidden>' +
          '<input type="checkbox" data-klar="bdiet-consent">' +
          '<span>' + esc(t.dietaryConsent) + '</span></label></div>' +
          '<p class="klar-err" data-klar="book-err" hidden></p>' +
          '<button type="button" class="klar-btn klar-btn-full" data-klar="book-submit">' +
          esc(t.book) + '</button>' +
          '</div><div data-klar="book-ok" class="klar-ok" hidden></div></div>'
        : '');

    function el(name) {
      return mount.querySelector('[data-klar="' + name + '"]');
    }

    if (showTabs) {
      var tabs = mount.querySelector('.klar-tabs');
      tabs.addEventListener('click', function (event) {
        var button = event.target.closest('button[data-klar-tab]');
        if (!button) return;
        var wanted = button.dataset.klarTab;
        tabs.querySelectorAll('button').forEach(function (other) {
          other.classList.toggle('klar-on', other === button);
        });
        mount.querySelectorAll('[data-klar-panel]').forEach(function (panel) {
          panel.classList.toggle('klar-on', panel.dataset.klarPanel === wanted);
        });
      });
    }

    /* ================================ ORDER ================================ */

    var catsWrap = el('cats');
    var itemsWrap = el('items');
    var cartWrap = el('cart');
    var categories = [];
    var activeCat = 0;
    var allowsEatIn = true;
    var currency = 'EUR';
    var cart = [];
    var fulfilment = 'eat_in';
    var checkoutKey = null;
    var sending = false;
    var orderName = '';
    var orderPhone = '';
    var orderErr = '';
    /* Kept so klar:sync can replay them to a host that mounted late. */
    var lastMenu = null;
    var lastCart = null;

    function lineFor(id) {
      for (var i = 0; i < cart.length; i++) if (cart[i].id === id) return cart[i];
      return null;
    }

    function itemById(id) {
      for (var c = 0; c < categories.length; c++) {
        for (var i = 0; i < categories[c].items.length; i++) {
          if (categories[c].items[i].id === id) return categories[c].items[i];
        }
      }
      return null;
    }

    function renderItems() {
      if (cfg.hostMenu) return;
      var category = categories[activeCat];
      if (!category) return;
      itemsWrap.innerHTML = category.items
        .map(function (item) {
          var line = lineFor(item.id);
          var qty = line ? line.qty : 0;
          var disabled = item.available === false;
          return (
            '<div class="klar-item"><div><h4>' + esc(item.name) + '</h4>' +
            (item.description ? '<p>' + esc(item.description) + '</p>' : '') +
            '</div><div class="klar-side"><span class="klar-price">' +
            esc(money(item.priceCents, item.currency || currency)) + '</span>' +
            '<button type="button" class="klar-add" data-klar-add="' + esc(item.id) + '"' +
            (disabled ? ' disabled' : '') + '>' +
            (qty > 0 ? esc(t.addMore) + ' · ' + qty : esc(t.add)) +
            '</button></div></div>'
          );
        })
        .join('');
    }

    function renderCart() {
      if (!cartWrap) return;
      var count = cart.reduce(function (sum, line) { return sum + line.qty; }, 0);
      var total = cart.reduce(function (sum, line) { return sum + line.cents * line.qty; }, 0);
      lastCart = {
        lines: cart.map(function (line) {
          return { id: line.id, name: line.name, cents: line.cents, qty: line.qty };
        }),
        count: count,
        totalCents: total,
        currency: currency
      };
      emit('klar:cart', lastCart);
      if (cart.length === 0) {
        cartWrap.innerHTML =
          '<h3>' + esc(t.cartTitle) + '</h3><p class="klar-muted">' + esc(t.cartEmpty) + '</p>';
        return;
      }
      cartWrap.innerHTML =
        '<h3>' + esc(t.cartTitle) + ' · ' + count + '</h3>' +
        cart
          .map(function (line) {
            return (
              '<div class="klar-line"><span class="klar-ln">' + esc(line.name) + '</span>' +
              '<span class="klar-qty">' +
              '<button type="button" data-klar-qty="' + esc(line.id) + '" data-klar-to="' +
              (line.qty - 1) + '" aria-label="-">−</button><span>' + line.qty + '</span>' +
              '<button type="button" data-klar-qty="' + esc(line.id) + '" data-klar-to="' +
              (line.qty + 1) + '" aria-label="+">+</button></span>' +
              '<span class="klar-lp">' + esc(money(line.cents * line.qty, currency)) + '</span></div>'
            );
          })
          .join('') +
        /* A takeaway-only restaurant has nothing to choose between. Rendering
           the one option as a button made it look like a second call to action
           sitting above the real one — so a single option states itself. */
        (allowsEatIn
          ? '<div class="klar-seg">' +
            '<button type="button" data-klar-ful="eat_in" class="' +
            (fulfilment === 'eat_in' ? 'klar-on' : '') + '">' + esc(t.eatIn) + '</button>' +
            '<button type="button" data-klar-ful="takeaway" class="' +
            (fulfilment === 'takeaway' ? 'klar-on' : '') + '">' + esc(t.takeaway) + '</button>' +
            '</div>'
          : '<p class="klar-only-ful">' + esc(t.takeaway) + '</p>') +
        '<div class="klar-field"><label>' + esc(t.name) + '</label>' +
        '<input type="text" autocomplete="name" data-klar="oname" placeholder="' +
        esc(t.namePlaceholder) + '" value="' + esc(orderName) + '"></div>' +
        '<div class="klar-field"><label>' + esc(t.phone) + ' ' + esc(t.optional) + '</label>' +
        '<input type="tel" autocomplete="tel" data-klar="ophone" value="' + esc(orderPhone) + '"></div>' +
        '<div class="klar-total"><span class="klar-muted">' + esc(t.total) + '</span>' +
        '<span class="klar-tv">' + esc(money(total, currency)) + '</span></div>' +
        (orderErr ? '<p class="klar-err">' + esc(orderErr) + '</p>' : '') +
        '<button type="button" class="klar-btn klar-btn-full" data-klar="order-submit"' +
        (sending ? ' disabled' : '') + '>' + esc(sending ? t.sending : t.send) + '</button>' +
        '<p class="klar-note">' + esc(t.payAtVenue) + '</p>';
    }

    /* Any change to what is being ordered starts a new checkout attempt: an
     * Idempotency-Key must never be reused for a different order (the API 409s). */
    function cartChanged() {
      checkoutKey = null;
    }

    function menuLoaded(data) {
      categories = (data.categories || []).filter(function (c) {
        return (c.items || []).length > 0;
      });
      allowsEatIn = data.client ? data.client.allowsEatIn !== false : true;
      if (!allowsEatIn) fulfilment = 'takeaway';
      var first = categories[0] && categories[0].items[0];
      if (first && first.currency) currency = first.currency;
      if (categories.length === 0) {
        warn('menu for "' + cfg.orderSlug + '" has no orderable categories.');
        itemsWrap.hidden = false;
        itemsWrap.innerHTML = '<p class="klar-muted">' + esc(t.orderingOff + callUs()) + '</p>';
        if (cartWrap) cartWrap.hidden = true;
        emit('klar:menu-failed', { reason: 'empty' });
        return;
      }
      lastMenu = {
        categories: categories,
        currency: currency,
        allowsEatIn: allowsEatIn,
        client: data.client || null
      };
      emit('klar:menu', lastMenu);
      if (cfg.hostMenu) {
        renderCart();
        return;
      }
      catsWrap.hidden = false;
      catsWrap.innerHTML = categories
        .map(function (category, index) {
          return (
            '<button type="button" class="' + (index === 0 ? 'klar-on' : '') +
            '" data-klar-cat="' + index + '">' + esc(category.name) + '</button>'
          );
        })
        .join('');
      renderItems();
      renderCart();
    }

    function loadMenu() {
      win
        .fetch(cfg.api + '/api/' + encodeURIComponent(cfg.orderSlug) + '/menu', {
          headers: { Accept: 'application/json' }
        })
        .then(function (response) {
          if (!response.ok) throw new Error('menu ' + response.status);
          return response.json();
        })
        .then(menuLoaded)
        .catch(function (error) {
          /* A 404 here is the ordinary "this slug is not provisioned for
           * ordering" answer; a TypeError is the browser refusing to read a
           * cross-origin response the allowlist did not cover. Both are dark
           * surfaces, so both say so out loud. */
          warn(
            'menu request failed for ordering slug "' + cfg.orderSlug + '" at ' + cfg.api +
              ' — the surface stays unavailable.',
            error
          );
          if (catsWrap) catsWrap.hidden = true;
          /* Host-menu mode keeps this slot hidden while things work; the
             fail-closed panel is the one thing it must still show. */
          itemsWrap.hidden = false;
          itemsWrap.innerHTML =
            '<p class="klar-muted">' +
            esc((/ 404$/.test(error.message) ? t.orderingOff : t.menuFailed) + callUs()) +
            '</p>';
          if (cartWrap) cartWrap.hidden = true;
          emit('klar:menu-failed', { reason: error && error.message ? error.message : 'failed' });
        });
    }

    function showOrderOk(order) {
      var reference = order.orderId ? String(order.orderId).slice(0, 6).toUpperCase() : '';
      el('order-live').hidden = true;
      var ok = el('order-ok');
      ok.hidden = false;
      ok.innerHTML =
        '<div class="klar-check">✓</div><h3>' + esc(t.orderOk) + '</h3>' +
        (reference ? '<p class="klar-muted">' + esc(t.reference) + ' <b>' + esc(reference) + '</b></p>' : '') +
        (typeof order.totalCents === 'number'
          ? '<div class="klar-big">' + esc(money(order.totalCents, order.currency || currency)) + '</div>'
          : '') +
        '<p class="klar-muted">' + esc(fulfilment === 'takeaway' ? t.collect : t.table) + '</p>' +
        '<button type="button" class="klar-btn" data-klar="order-again" style="margin-top:20px">' +
        esc(t.orderAgain) + '</button>';
      cart = [];
      orderName = '';
      orderPhone = '';
      orderErr = '';
      checkoutKey = null;
      renderItems();
      renderCart();
      el('order-again').addEventListener('click', function () {
        ok.hidden = true;
        el('order-live').hidden = false;
      });
    }

    function placeOrder() {
      if (sending) return;
      if (!orderName.trim()) {
        orderErr = t.needName;
        renderCart();
        return;
      }
      orderErr = '';
      sending = true;
      renderCart();
      if (!checkoutKey) checkoutKey = newKey();
      win
        .fetch(cfg.api + '/api/' + encodeURIComponent(cfg.orderSlug) + '/order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': checkoutKey },
          body: JSON.stringify({
            guestName: orderName.trim(),
            guestPhone: orderPhone.trim() || undefined,
            fulfilmentType: fulfilment,
            items: cart.map(function (line) {
              return { menuItemId: line.id, qty: line.qty };
            })
          })
        })
        .then(readJson)
        .then(function (result) {
          sending = false;
          if (!result.ok) {
            warn('order rejected for "' + cfg.orderSlug + '" (' + result.status + ').', result.body);
            orderErr =
              result.status === 429
                ? t.tooMany
                : // Never `result.body.error`. The API writes that string in one
                  // language and this embed renders in another, so the fallback
                  // showed English "Order could not be placed" on a Finnish
                  // embed and Finnish "Liian monta tilausta" on an English one.
                  // An unmapped code gets the embed's own generic instead.
                  t.codes[result.body.code] || t.generic + callUs();
            renderCart();
            return;
          }
          showOrderOk(result.body.order || {});
        })
        .catch(function (error) {
          sending = false;
          warn('order request failed for "' + cfg.orderSlug + '".', error);
          orderErr = t.generic + callUs();
          renderCart();
        });
    }

    /* The one way anything enters the cart — the embed's own buttons and a
     * host site's klar:add both come through here, so an id the loaded menu
     * does not carry is refused once, in one place. */
    function addToCart(id, qty) {
      var step = typeof qty === 'number' && qty ? Math.round(qty) : 1;
      var item = itemById(id);
      if (!item) {
        warn(
          'klar:add refused — "' + id + '" is not an item on the loaded menu for "' +
            cfg.orderSlug + '".'
        );
        return false;
      }
      if (item.available === false) {
        warn('klar:add refused — "' + item.name + '" is not available.');
        return false;
      }
      var line = lineFor(id);
      if (line) {
        line.qty += step;
        if (line.qty <= 0) cart = cart.filter(function (other) { return other.id !== id; });
      } else if (step > 0) {
        cart.push({ id: item.id, name: item.name, cents: item.priceCents, qty: step });
      } else {
        return false;
      }
      cartChanged();
      renderItems();
      renderCart();
      return true;
    }

    if (cfg.order) {
      itemsWrap.addEventListener('click', function (event) {
        var button = event.target.closest('button[data-klar-add]');
        if (!button || button.disabled) return;
        addToCart(button.dataset.klarAdd, 1);
      });

      mount.addEventListener('klar:add', function (event) {
        var detail = event.detail || {};
        addToCart(detail.id, detail.qty);
      });

      /* A host that mounted after the menu landed asks for the state again
         rather than waiting for an event that has already been and gone. */
      doc.addEventListener('klar:sync', function () {
        if (lastMenu) emit('klar:menu', lastMenu);
        if (lastCart) emit('klar:cart', lastCart);
      });

      catsWrap.addEventListener('click', function (event) {
        var button = event.target.closest('button[data-klar-cat]');
        if (!button) return;
        activeCat = Number(button.dataset.klarCat);
        catsWrap.querySelectorAll('button').forEach(function (other) {
          other.classList.toggle('klar-on', other === button);
        });
        renderItems();
      });

      cartWrap.addEventListener('click', function (event) {
        var qtyButton = event.target.closest('button[data-klar-qty]');
        if (qtyButton) {
          var id = qtyButton.dataset.klarQty;
          var to = Number(qtyButton.dataset.klarTo);
          if (to <= 0) {
            cart = cart.filter(function (line) { return line.id !== id; });
          } else {
            var line = lineFor(id);
            if (line) line.qty = to;
          }
          cartChanged();
          renderItems();
          renderCart();
          return;
        }
        var fulButton = event.target.closest('button[data-klar-ful]');
        if (fulButton) {
          fulfilment = fulButton.dataset.klarFul;
          cartChanged();
          renderCart();
          return;
        }
        if (event.target.closest('[data-klar="order-submit"]')) placeOrder();
      });

      cartWrap.addEventListener('input', function (event) {
        var field = event.target.dataset ? event.target.dataset.klar : null;
        if (field === 'oname') orderName = event.target.value;
        if (field === 'ophone') orderPhone = event.target.value;
      });

      renderCart();
    }

    /* ================================= BOOK ================================= */

    var dateEl = el('date');
    var partyEl = el('party');
    var slotsEl = el('slots');
    var bookErrEl = el('book-err');
    var bookBtn = el('book-submit');
    var chosenSlot = '';
    var booking = false;

    function showBookErr(message) {
      bookErrEl.textContent = message;
      bookErrEl.hidden = !message;
    }

    function loadSlots() {
      chosenSlot = '';
      if (!dateEl.value) {
        slotsEl.innerHTML = '<span class="klar-muted">—</span>';
        return;
      }
      slotsEl.innerHTML = '<span class="klar-muted">' + esc(t.slotsLoading) + '</span>';
      win
        .fetch(
          cfg.api + '/api/' + encodeURIComponent(cfg.bookSlug) + '/availability?date=' +
            encodeURIComponent(dateEl.value) + '&party_size=' + encodeURIComponent(partyEl.value)
        )
        .then(function (response) {
          if (!response.ok) throw new Error('availability ' + response.status);
          return response.json();
        })
        .then(function (data) {
          var slots = data.slots || [];
          if (slots.length === 0) {
            slotsEl.innerHTML = '<span class="klar-muted">' + esc(t.closed) + '</span>';
            return;
          }
          if (!slots.some(function (slot) { return slot.available; })) {
            slotsEl.innerHTML = '<span class="klar-muted">' + esc(t.noSlots + callUs()) + '</span>';
            return;
          }
          slotsEl.innerHTML = slots
            .map(function (slot) {
              return (
                '<button type="button" data-klar-slot="' + esc(slot.time) + '"' +
                (slot.available ? '' : ' disabled') + '>' + esc(hhmm(slot.time)) + '</button>'
              );
            })
            .join('');
        })
        .catch(function (error) {
          warn(
            'availability request failed for booking slug "' + cfg.bookSlug + '" at ' + cfg.api +
              ' — no times can be offered.',
            error
          );
          slotsEl.innerHTML =
            '<span class="klar-muted">' +
            esc((/ 404$/.test(error.message) ? t.bookingOff : t.slotsFailed) + callUs()) +
            '</span>';
        });
    }

    function showBookOk(name, confirmed) {
      el('book-live').hidden = true;
      var ok = el('book-ok');
      var people = Number(partyEl.value);
      ok.hidden = false;
      ok.innerHTML =
        '<div class="klar-check">✓</div><h3>' + esc(t.bookOk) + '</h3>' +
        '<p class="klar-muted">' + esc(name) + ' · ' + people + ' ' +
        esc(people === 1 ? t.person : t.people) + '</p>' +
        '<div class="klar-big">' + esc(confirmed.date || dateEl.value) + ' ' + esc(t.at) + ' ' +
        esc(hhmm(confirmed.time_slot || chosenSlot)) + '</div>' +
        '<p class="klar-muted">' + esc(t.bookConfirm) + '</p>' +
        '<button type="button" class="klar-btn" data-klar="book-again" style="margin-top:20px">' +
        esc(t.bookAgain) + '</button>';
      el('book-again').addEventListener('click', function () {
        ok.hidden = true;
        el('book-live').hidden = false;
        el('bname').value = '';
        el('bphone').value = '';
        el('bemail').value = '';
        el('breq').value = '';
        el('bdiet').value = '';
        el('bdiet-consent').checked = false;
        el('bdiet-consent-row').hidden = true;
        chosenSlot = '';
        loadSlots();
      });
    }

    if (cfg.book) {
      var today = todayIn(cfg.timezone);
      dateEl.min = today;
      dateEl.max = plusDays(today, BOOKING_HORIZON_DAYS);
      dateEl.value = today;
      for (var size = 1; size <= cfg.partyMax; size++) {
        var option = doc.createElement('option');
        option.value = String(size);
        option.textContent = size + ' ' + (size === 1 ? t.person : t.people);
        if (size === 2) option.selected = true;
        partyEl.appendChild(option);
      }

      slotsEl.addEventListener('click', function (event) {
        var button = event.target.closest('button[data-klar-slot]');
        if (!button || button.disabled) return;
        chosenSlot = button.dataset.klarSlot;
        slotsEl.querySelectorAll('button').forEach(function (other) {
          other.classList.toggle('klar-on', other === button);
        });
      });
      dateEl.addEventListener('change', loadSlots);
      partyEl.addEventListener('change', loadSlots);

      /* The tick appears only once there is an allergy to consent to, and an
         emptied field takes the tick away with it — otherwise a guest who
         typed and then deleted would leave a consent standing over nothing. */
      el('bdiet').addEventListener('input', function () {
        var has = el('bdiet').value.trim().length > 0;
        el('bdiet-consent-row').hidden = !has;
        if (!has) el('bdiet-consent').checked = false;
      });

      bookBtn.addEventListener('click', function () {
        if (booking) return;
        var name = el('bname').value.trim();
        var phone = el('bphone').value.trim();
        var email = el('bemail').value.trim();
        var requests = el('breq').value.trim();
        var diet = el('bdiet').value.trim();
        var dietConsent = el('bdiet-consent').checked;
        if (!dateEl.value || !chosenSlot || !name || !phone || !email) {
          showBookErr(t.bookFields);
          return;
        }
        /* Refused here as well as on the server. The server is what makes it
           true — a checkbox is a suggestion and a direct POST ignores it — but
           being turned away in the form costs the guest nothing. */
        if (diet && !dietConsent) {
          showBookErr(t.dietaryConsentMissing);
          return;
        }
        showBookErr('');
        booking = true;
        bookBtn.disabled = true;
        bookBtn.textContent = t.booking;
        win
          .fetch(cfg.api + '/api/' + encodeURIComponent(cfg.bookSlug) + '/book', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              guest_name: name,
              guest_phone: phone,
              guest_email: email,
              party_size: Number(partyEl.value),
              date: dateEl.value,
              time_slot: chosenSlot,
              special_requests: requests || undefined,
              dietary_notes: diet || undefined,
              health_consent: diet ? dietConsent : undefined,
              health_consent_language: cfg.locale,
              source: 'widget'
            })
          })
          .then(readJson)
          .then(function (result) {
            booking = false;
            bookBtn.disabled = false;
            bookBtn.textContent = t.book;
            if (!result.ok) {
              warn('booking rejected for "' + cfg.bookSlug + '" (' + result.status + ').', result.body);
              /* The API returns per-field messages — show them, they are more
               * useful than the summary. */
              var fields = result.body.fields;
              var detail = fields
                ? Object.keys(fields)
                    .map(function (key) {
                      return /invalid phone/i.test(fields[key]) ? t.badPhone : fields[key];
                    })
                    .join(' · ')
                : '';
              showBookErr(detail || result.body.error || t.generic + callUs());
              if (result.body.code === 'SLOT_TAKEN') loadSlots();
              return;
            }
            showBookOk(name, result.body.booking || {});
          })
          .catch(function (error) {
            booking = false;
            bookBtn.disabled = false;
            bookBtn.textContent = t.book;
            warn('booking request failed for "' + cfg.bookSlug + '".', error);
            showBookErr(t.generic + callUs());
          });
      });
    }

    /* ---- lazy start: a visitor who never scrolls here pays for no request ---- */
    var started = false;
    function start() {
      if (started) return;
      started = true;
      if (cfg.order) loadMenu();
      if (cfg.book) loadSlots();
    }
    mount.klarStart = start; /* so a nav link or a test can force it */

    if (win.IntersectionObserver) {
      var observer = new win.IntersectionObserver(
        function (entries) {
          if (
            entries.some(function (entry) {
              return entry.isIntersecting;
            })
          ) {
            start();
            observer.disconnect();
          }
        },
        { rootMargin: '600px' }
      );
      observer.observe(mount);

      /* Warm it once the page is otherwise idle, so the section is ALREADY
         filled when the visitor reaches it. 600px of rootMargin still means the
         menu is fetched while they are scrolling towards it, and on a slow
         connection they arrive at "Loading the menu…" — which reads as broken
         rather than as loading. The observer stays: it is what catches a visitor
         who lands mid-page, and start() is idempotent. */
      if (win.requestIdleCallback) {
        win.requestIdleCallback(start, { timeout: 2000 });
      } else {
        win.setTimeout(start, 1200);
      }
    } else {
      start();
    }

    /* A direct #anchor link into the section must not wait for the observer. */
    function startOnHash() {
      var id = mount.id || (mount.closest('[id]') && mount.closest('[id]').id);
      if (id && win.location.hash === '#' + id) start();
    }
    startOnHash();
    win.addEventListener('hashchange', startOnHash);
  }

  /* ------------------------------------------------------------------ boot --- */

  function boot() {
    var win = typeof window !== 'undefined' ? window : null;
    if (!win || !win.document) return;
    if (!win.fetch) {
      warn('this browser has no fetch(); the ordering and booking surfaces cannot load.');
      return;
    }
    var mounts = win.document.querySelectorAll('[data-klar-slug],[data-klar-order-slug],[data-klar-book-slug]');
    if (mounts.length === 0) {
      warn('no mount element found — add <div data-klar-slug="your-slug"></div> to the page.');
      return;
    }
    mounts.forEach(function (mount) {
      if (mount.dataset.klarMounted === '1') return;
      mount.dataset.klarMounted = '1';
      try {
        mountKlar(mount, win);
      } catch (error) {
        /* One broken mount must never take the rest of the page with it. */
        warn('mount failed.', error);
      }
    });
  }

  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
