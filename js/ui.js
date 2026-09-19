/* ==========================================================================
   Power Forge — ui.js
   All DOM: title, power selection, HUD, menus and level-up cards. The canvas
   never draws UI chrome except world-space text.
   ========================================================================== */
(function (PF) {
  'use strict';

  const U = PF.U;
  const Levels = PF.Levels;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function css(colors) { return U.rgb(colors.primary); }

  /* Normalised 0..1 meters for the power comparison panel. */
  function powerMeters() {
    const list = PF.Powers.list();
    const raw = list.map((p) => ({
      id: p.id,
      dps: p.base.damage * (p.shot.count || 1) / p.base.cooldown,
      hit: p.base.damage * (p.shot.count || 1),
      speed: p.base.projSpeed,
      hp: p.base.maxHp,
      mobility: p.base.moveSpeed * 0.7 + p.base.jumpForce * 0.3
    }));
    const keys = ['dps', 'hit', 'speed', 'hp', 'mobility'];
    const bounds = {};
    keys.forEach((k) => {
      bounds[k] = {
        min: Math.min.apply(null, raw.map((r) => r[k])),
        max: Math.max.apply(null, raw.map((r) => r[k]))
      };
    });
    const out = {};
    raw.forEach((r) => {
      out[r.id] = {};
      keys.forEach((k) => {
        const b = bounds[k];
        out[r.id][k] = b.max === b.min ? 1 : 0.18 + 0.82 * (r[k] - b.min) / (b.max - b.min);
      });
      out[r.id].values = r;
    });
    return out;
  }

  class UI {
    constructor(game) {
      this.game = game;
      this.screen = 'title';
      this.menuOpen = false;
      this.levelUpTimer = 0;
      this.activeTab = 'power';
      this.pendingPower = null;
      this.meters = powerMeters();
      this.abilitySlots = [];
      this.abilityRows = [];
      this.abilityPanelOpen = false;
      this.hintTimer = 0;
      this._promptText = '';
      this._toasts = [];
    }

    /* ---- setup --------------------------------------------------------- */

    init() {
      this.e = {
        hud: $('hud'),
        hudPanel: $('hud-panel'),
        abilityToggleBtn: $('btn-toggle-abilities'),
        powerIcon: $('hud-power-icon'),
        powerName: $('hud-power-name'),
        powerChip: $('hud-power-chip'),
        level: $('hud-level'),
        expText: $('hud-exp-text'),
        expFill: $('hud-exp-fill'),
        abilities: $('hud-abilities'),
        abilityPanel: $('ability-panel'),
        abilityPanelList: $('ability-panel-list'),
        hint: $('hud-hint'),
        prompt: $('prompt'),
        toasts: $('toasts'),
        levelup: $('levelup'),
        luLevel: $('lu-level'),
        luStats: $('lu-stats'),
        luAbility: $('lu-ability'),
        luAbIcon: $('lu-ab-icon'),
        luAbTitle: $('lu-ab-title'),
        luAbDesc: $('lu-ab-desc'),
        luAbKey: $('lu-ab-key'),
        screenTitle: $('screen-title'),
        screenSelect: $('screen-select'),
        powerGrid: $('power-grid'),
        selectDetail: $('select-detail'),
        btnSelect: $('btn-select-power'),
        overlayMenu: $('overlay-menu'),
        menuBody: $('menu-body'),
        menuTabs: $('menu-tabs'),
        btnSound: $('btn-toggle-sound'),
        debug: $('debug'),
        inventorySlot: $('hud-inventory'),
        inventoryCount: $('hud-inventory-count'),
        btnToggleShop: $('btn-toggle-shop'),
        shopPanel: $('shop-panel'),
        shopPanelList: $('shop-panel-list'),
        shopPanelMeat: $('shop-panel-meat')
      };

      this._buildPowerGrid();
      this._bind();
    }

    _bind() {
      const g = this.game;

      $('btn-play').addEventListener('click', () => {
        PF.Audio.unlock(); PF.Audio.click();
        this.showScreen('select');
      });
      $('btn-back-title').addEventListener('click', () => {
        PF.Audio.click();
        this.showScreen('title');
      });
      this.e.btnSelect.addEventListener('click', () => {
        if (!this.pendingPower) return;
        PF.Audio.click();
        g.startRun(this.pendingPower);
      });

      $('btn-close-menu').addEventListener('click', () => { PF.Audio.click(); this.closeMenu(); });
      $('btn-resume').addEventListener('click', () => { PF.Audio.click(); this.closeMenu(); });
      $('btn-toggle-abilities').addEventListener('click', () => {
        PF.Audio.click();
        this.toggleAbilityPanel();
      });
      this.e.btnToggleShop.addEventListener('click', () => {
        PF.Audio.click();
        this.toggleShopPanel();
      });

      this.e.btnSound.addEventListener('click', () => {
        const muted = PF.Audio.toggleMute();
        this.e.btnSound.textContent = 'SOUND: ' + (muted ? 'OFF' : 'ON');
        if (!muted) PF.Audio.click();
      });

      Array.prototype.forEach.call(this.e.menuTabs.children, (tab) => {
        tab.addEventListener('click', () => {
          PF.Audio.click();
          this.activeTab = tab.getAttribute('data-tab');
          Array.prototype.forEach.call(this.e.menuTabs.children, (t) => t.classList.remove('active'));
          tab.classList.add('active');
          this._renderMenuBody();
        });
      });
    }

    /* ---- screens -------------------------------------------------------- */

    showScreen(name) {
      this.screen = name;
      this.e.screenTitle.classList.toggle('hidden', name !== 'title');
      this.e.screenSelect.classList.toggle('hidden', name !== 'select');
      this.e.hud.classList.toggle('hidden', name !== 'game');
      if (name !== 'game') this.hideAllOverlays();
      PF.Input.reset();
    }

    /* ---- power selection ------------------------------------------------ */

    _buildPowerGrid() {
      const grid = this.e.powerGrid;
      grid.innerHTML = '';
      PF.Powers.list().forEach((p) => {
        const card = el('div', 'power-card card-btn card-btn-' + p.id);
        card.style.setProperty('--pc', css(p.colors));
        card.innerHTML =
          '<div class="pc-icon">' + p.icon + '</div>' +
          '<div class="pc-name">' + p.name + '</div>' +
          '<div class="pc-tag">' + p.tagline + '</div>';
        card.addEventListener('mouseenter', () => PF.Audio.hover());
        card.addEventListener('click', () => {
          PF.Audio.click();
          this.pendingPower = p.id;
          Array.prototype.forEach.call(grid.children, (c) => c.classList.remove('selected'));
          card.classList.add('selected');
          this.e.btnSelect.disabled = false;
          // The SELECT POWER button picks up the chosen element's color too.
          PF.Powers.order.forEach((id) => this.e.btnSelect.classList.remove('card-btn-' + id));
          this.e.btnSelect.classList.add('card-btn-' + p.id);
          this._renderPowerDetail(p);
        });
        grid.appendChild(card);
      });
    }

    _renderPowerDetail(p) {
      const m = this.meters[p.id];
      const abilities = PF.Abilities.forPower(p.id);
      const color = css(p.colors);

      const meter = (label, value, shown) =>
        '<div class="stat-row"><span class="sn">' + label + '</span>' +
        '<span class="meter"><i style="width:' + Math.round(value * 100) + '%"></i></span>' +
        '<span class="sv">' + shown + '</span></div>';

      const v = m.values;
      const html =
        '<div class="sd-grid" style="--pc:' + color + '">' +
          '<div>' +
            '<div class="sd-title" style="color:' + color + '">' + p.icon + '  ' + p.name + '</div>' +
            '<div class="sd-blurb">' + p.blurb + '</div>' +
          '</div>' +
          '<div>' +
            '<div class="sd-h">COMBAT PROFILE</div>' +
            meter('DPS', m.dps, Math.round(v.dps)) +
            meter('PER HIT', m.hit, Math.round(v.hit)) +
            meter('PROJ SPD', m.speed, Math.round(v.speed / 100) / 10 + 'k') +
            meter('HEALTH', m.hp, v.hp) +
            meter('MOBILITY', m.mobility, Math.round(p.base.moveSpeed)) +
          '</div>' +
          '<div>' +
            '<div class="sd-h">ABILITY PATH</div>' +
            abilities.map((a) =>
              '<div class="ab-row"><span class="lv">LV ' + a.unlockLevel + '</span>' +
              '<span class="nm">' + a.icon + ' ' + a.name + '</span></div>'
            ).join('') +
          '</div>' +
        '</div>';
      this.e.selectDetail.innerHTML = html;
    }

    /* ---- HUD ------------------------------------------------------------ */

    /* Two views of the same data: a small always-on cooldown dock, and the
       full named reference that toggles on TAB. */
    buildAbilityBar(player) {
      const color = css(player.power.colors);
      const box = this.e.abilities;
      box.innerHTML = '';
      this.abilitySlots = [];

      player.abilities.forEach((a) => {
        const slot = el('div', 'ab-slot card-btn card-btn-neutral');
        slot.style.setProperty('--pc', color);
        slot.title = a.name + ' — ' + a.desc;
        slot.innerHTML =
          '<span class="ab-ico">' + a.icon + '</span>' +
          '<i class="ab-cool"></i>' +
          '<span class="ab-cd"></span>' +
          '<span class="ab-key">' + (a.keyLabel || '—') + '</span>';
        box.appendChild(slot);
        this.abilitySlots.push({
          ability: a,
          node: slot,
          cool: slot.querySelector('.ab-cool'),
          cd: slot.querySelector('.ab-cd')
        });
      });

      const list = this.e.abilityPanelList;
      list.style.setProperty('--pc', color);
      list.innerHTML = player.abilities.map((a) =>
        '<div class="ap-row" data-ab="' + a.id + '">' +
          '<div class="r-ico">' + a.icon + '</div>' +
          '<div class="r-body">' +
            '<div class="r-top">' +
              '<span class="r-name">' + a.name.toUpperCase() + '</span>' +
              '<span class="r-key">' + (a.keyLabel || '—') + '</span>' +
            '</div>' +
            '<div class="r-desc">' + a.desc + '</div>' +
          '</div>' +
        '</div>'
      ).join('');
      this.abilityRows = player.abilities.map((a) => ({
        ability: a,
        node: list.querySelector('[data-ab="' + a.id + '"]'),
        key: list.querySelector('[data-ab="' + a.id + '"] .r-key')
      }));
    }

    toggleAbilityPanel(force) {
      const show = force == null ? this.e.abilityPanel.classList.contains('hidden') : !!force;
      this.e.abilityPanel.classList.toggle('hidden', !show);
      // The panel sits directly over the small cooldown dock (same corner,
      // same width) — showing both at once was always a bit redundant, but
      // it only became visually obvious once neither one has a background
      // to paint over the other: the dock's key-badges and the panel's own
      // text ended up literally interleaved. Hide the dock while the full
      // reference is open; its info (icon, key, cooldown) is a subset of
      // what the panel already shows.
      this.e.abilities.classList.toggle('hidden', show);
      this.abilityPanelOpen = show;
      if (show) PF.Audio.hover();
    }

    /* ---- shop (bottom-left, mirrors the ability panel opposite it) ------- */

    /* Built once per run (called alongside buildAbilityBar) — rows are
       created up front and just toggled/updated afterward (see
       updateShopPanel), the same live-node approach the ability dock uses,
       rather than re-building innerHTML on every purchase or every frame. */
    buildShopPanel(player) {
      const list = this.e.shopPanelList;
      list.innerHTML = '';
      this.shopRows = PF.Shop.items.map((item) => {
        const row = el('div', 'ability-item');
        row.innerHTML =
          '<div class="ai-ico">' + item.icon + '</div>' +
          '<div>' +
            '<div class="ai-name">' + item.name.toUpperCase() + '</div>' +
            '<div class="ai-desc">' + item.desc + '</div>' +
          '</div>' +
          '<div class="ai-meta"></div>';
        const meta = row.querySelector('.ai-meta');
        const buyBtn = el('button', 'btn btn-sm card-btn card-btn-good', 'BUY — ' + item.cost);
        buyBtn.addEventListener('click', () => {
          if (!player.buyShopItem(item)) return;
          PF.Audio.click();
          this.toast(item.name.toUpperCase(), 'Purchased for ' + item.cost + ' meat.');
          this.updateShopPanel(player);
        });
        meta.appendChild(buyBtn);
        list.appendChild(row);
        return { item: item, row: row, meta: meta, buyBtn: buyBtn, owned: false };
      });
      this.updateShopPanel(player);
    }

    /* Cheap per-frame refresh: just the meat count and each row's
       afford/owned state — never rebuilds the DOM (see buildShopPanel). */
    updateShopPanel(player) {
      if (!this.shopRows) return;
      this.e.shopPanelMeat.textContent = U.fmt(player.meatCount);
      for (const r of this.shopRows) {
        const owned = !!player.shopUpgrades[r.item.id];
        if (owned && !r.owned) {
          r.owned = true;
          r.row.classList.add('locked');
          r.meta.innerHTML = '<div class="pill on">✓ OWNED</div>';
        } else if (!owned) {
          r.buyBtn.disabled = player.meatCount < r.item.cost;
        }
      }
    }

    toggleShopPanel(force) {
      const show = force == null ? this.e.shopPanel.classList.contains('hidden') : !!force;
      this.e.shopPanel.classList.toggle('hidden', !show);
      if (show) { PF.Audio.hover(); this.updateShopPanel(this.game.player); }
    }

    setPowerTheme(power) {
      const c = css(power.colors);
      this.e.powerChip.style.setProperty('--pc', c);
      this.e.powerIcon.textContent = power.icon;
      this.e.powerIcon.style.setProperty('--pc', c);
      this.e.powerName.textContent = power.name;
      document.documentElement.style.setProperty('--accent', c);

      // The top-left card, the ABILITIES button and the ability dock slots
      // (built in buildAbilityBar) all stay on the neutral card-btn texture
      // regardless of the run's power — only the icon/text glow (--pc, set
      // above and per-slot in buildAbilityBar) carries the power's color.
    }

    updateHUD(player) {
      const e = this.e;
      e.level.textContent = player.level;

      const capped = player.level >= Levels.MAX_LEVEL;
      const expPct = capped ? 100 : U.clamp(player.exp / player.expToNext * 100, 0, 100);
      e.expFill.style.width = expPct + '%';
      e.expText.textContent = capped ? 'MAX LEVEL'
        : U.fmt(player.exp) + ' / ' + U.fmt(player.expToNext);

      // HP itself now renders in-world above the player (js/healthbar.js),
      // not in this card — see index.html's hud-panel.

      // Stays hidden until you've actually picked something up, rather than
      // sitting there empty from the first frame.
      const hasMeat = player.meatCount > 0;
      e.inventorySlot.classList.toggle('hidden', !hasMeat);
      if (hasMeat) e.inventoryCount.textContent = player.meatCount;

      if (!e.shopPanel.classList.contains('hidden')) this.updateShopPanel(player);

      for (const slot of this.abilitySlots) {
        const a = slot.ability;
        const unlocked = player.level >= a.unlockLevel;
        // Locked abilities aren't dimmed here, they're absent entirely — the
        // dock only ever shows what you can actually cast. The full list
        // (including locked entries and their unlock levels) lives in the
        // ABILITIES panel.
        slot.node.classList.toggle('slot-hidden', !unlocked);
        if (!unlocked) continue;
        if (a.type === 'toggle') {
          slot.cd.textContent = '';
          slot.cool.style.height = '0';
          slot.node.classList.toggle('active', player.flying);
          slot.node.classList.toggle('ready', !player.flying);
          continue;
        }
        const cd = player.cooldowns[a.id] || 0;
        if (cd > 0) {
          slot.cd.textContent = cd >= 1 ? Math.ceil(cd) : cd.toFixed(1);
          slot.cool.style.height = (cd / a.cooldown * 100) + '%';
          slot.node.classList.remove('ready', 'active');
        } else {
          slot.cd.textContent = '';
          slot.cool.style.height = '0';
          slot.node.classList.add('ready');
          slot.node.classList.remove('active');
        }
      }

      if (this.abilityPanelOpen) {
        for (const row of this.abilityRows) {
          const unlocked = player.level >= row.ability.unlockLevel;
          row.node.classList.toggle('locked', !unlocked);
          row.key.classList.toggle('lock', !unlocked);
          row.key.textContent = unlocked
            ? (row.ability.keyLabel || '—')
            : 'LV ' + row.ability.unlockLevel;
        }
      }
    }

    /* The control hint is useful for the first few seconds and clutter after
       that, so it fades itself out and returns briefly on each area change. */
    showHint(seconds) {
      this.hintTimer = seconds;
      this.e.hint.classList.remove('faded');
    }

    flashAbility(ability) {
      for (const slot of this.abilitySlots) {
        if (slot.ability.id !== ability.id) continue;
        slot.node.classList.remove('flash');
        void slot.node.offsetWidth;   // restart the CSS animation
        slot.node.classList.add('flash');
      }
    }

    /* ---- prompts & toasts ------------------------------------------------ */

    showPrompt(html) {
      if (this._promptText === html) return;
      this._promptText = html;
      this.e.prompt.innerHTML = html;
      this.e.prompt.classList.remove('hidden');
    }

    hidePrompt() {
      if (!this._promptText) return;
      this._promptText = '';
      this.e.prompt.classList.add('hidden');
    }

    toast(title, sub) {
      const node = el('div', 'toast',
        '<div class="tt">' + title + '</div>' + (sub ? '<div class="ts">' + sub + '</div>' : ''));
      this.e.toasts.appendChild(node);
      setTimeout(() => {
        node.classList.add('out');
        setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node); }, 320);
      }, 2400);
      // Never let toasts stack off-screen.
      while (this.e.toasts.children.length > 4) {
        this.e.toasts.removeChild(this.e.toasts.firstChild);
      }
    }

    /* ---- level up -------------------------------------------------------- */

    showLevelUp(level, ability, statDelta) {
      const e = this.e;
      e.luLevel.textContent = level;
      e.luStats.innerHTML = statDelta.map((s) => '<span>' + s + '</span>').join('');

      if (ability) {
        e.luAbility.classList.remove('hidden');
        e.luAbIcon.textContent = ability.icon;
        e.luAbTitle.textContent = ability.name.toUpperCase();
        e.luAbDesc.textContent = ability.desc;
        e.luAbKey.textContent = ability.keyLabel || '—';
      } else {
        e.luAbility.classList.add('hidden');
      }

      e.levelup.classList.remove('hidden');
      // Restart the pop animation even on back-to-back level ups.
      const card = e.levelup.querySelector('.levelup-card');
      card.style.animation = 'none';
      void card.offsetWidth;
      card.style.animation = '';
      this.levelUpTimer = ability ? 4.2 : 2.3;
    }

    update(dt) {
      if (this.levelUpTimer > 0) {
        this.levelUpTimer -= dt;
        if (this.levelUpTimer <= 0) this.e.levelup.classList.add('hidden');
      }
      if (this.hintTimer > 0) {
        this.hintTimer -= dt;
        if (this.hintTimer <= 0) this.e.hint.classList.add('faded');
      }
    }

    /* ---- menus ----------------------------------------------------------- */

    isBlocking() {
      return this.menuOpen || this.screen !== 'game';
    }

    hideAllOverlays() {
      this.e.overlayMenu.classList.add('hidden');
      this.menuOpen = false;
    }

    toggleMenu() { this.menuOpen ? this.closeMenu() : this.openMenu(); }

    openMenu() {
      if (this.screen !== 'game') return;
      this.menuOpen = true;
      this.e.overlayMenu.classList.remove('hidden');
      this.e.btnSound.textContent = 'SOUND: ' + (PF.Audio.isMuted() ? 'OFF' : 'ON');
      this._renderMenuBody();
      PF.Input.reset();
    }

    closeMenu() {
      this.menuOpen = false;
      this.e.overlayMenu.classList.add('hidden');
      PF.Input.reset();
    }

    _renderMenuBody() {
      const g = this.game;
      const p = g.player;
      if (!p) return;
      const body = this.e.menuBody;
      const color = css(p.power.colors);
      body.style.setProperty('--pc', color);

      if (this.activeTab === 'power') {
        const s = p.stats;
        const capped = p.level >= Levels.MAX_LEVEL;
        body.innerHTML =
          '<div class="section-h">POWER TYPE</div>' +
          '<div class="kv">' +
            '<div class="k">ELEMENT</div><div class="v" style="color:' + color + '">' + p.power.icon + '  ' + p.power.name + '</div>' +
            '<div class="k">STYLE</div><div class="v">' + p.power.tagline + '</div>' +
            '<div class="k">LEVEL</div><div class="v">' + p.level + (capped ? '  (MAX)' : '') + '</div>' +
            '<div class="k">EXP</div><div class="v">' + (capped ? '—' : U.fmt(p.exp) + ' / ' + U.fmt(p.expToNext)) + '</div>' +
            '<div class="k">POWER SCORE</div><div class="v">' + Levels.powerScore(s) + '</div>' +
          '</div>' +
          '<div class="section-h">COMBAT STATS</div>' +
          '<div class="kv">' +
            '<div class="k">DAMAGE</div><div class="v">' + s.damage.toFixed(1) + (p.power.shot.count > 1 ? '  × ' + p.power.shot.count + ' shots' : '') + '</div>' +
            '<div class="k">FIRE RATE</div><div class="v">' + (1 / s.cooldown).toFixed(2) + ' / sec</div>' +
            '<div class="k">DPS</div><div class="v">' + (s.damage * (p.power.shot.count || 1) / s.cooldown).toFixed(1) + '</div>' +
            '<div class="k">MAX HP</div><div class="v">' + s.maxHp + '</div>' +
            '<div class="k">PROJ SPEED</div><div class="v">' + s.projSpeed + '</div>' +
            '<div class="k">MOVE SPEED</div><div class="v">' + s.moveSpeed + '</div>' +
            '<div class="k">JUMP</div><div class="v">' + s.jumpForce + '</div>' +
          '</div>';
      } else if (this.activeTab === 'abilities') {
        body.innerHTML =
          '<div class="section-h">ABILITY PATH</div>' +
          p.abilities.map((a) => {
            const unlocked = p.level >= a.unlockLevel;
            return '<div class="ability-item' + (unlocked ? '' : ' locked') + '">' +
              '<div class="ai-ico">' + a.icon + '</div>' +
              '<div>' +
                '<div class="ai-name">' + a.name.toUpperCase() + '</div>' +
                '<div class="ai-desc">' + a.desc + '</div>' +
              '</div>' +
              '<div class="ai-meta">' +
                '<div class="pill ' + (unlocked ? 'on' : 'off') + '">' +
                  (unlocked ? '✓ UNLOCKED' : '🔒 LEVEL ' + a.unlockLevel) + '</div>' +
                (unlocked ? '<div class="pill key" style="margin-top:6px">' + (a.keyLabel || '—') + '</div>' : '') +
                (a.cooldown ? '<div class="pill" style="margin-top:6px">' + a.cooldown + 's CD</div>' : '') +
              '</div>' +
            '</div>';
          }).join('');
      } else if (this.activeTab === 'stats') {
        body.innerHTML =
          '<div class="section-h">RUN SUMMARY</div>' +
          '<div class="kv">' +
            '<div class="k">TOTAL EXP</div><div class="v">' + U.fmt(p.totalExpEarned) + '</div>' +
            '<div class="k">TIMES DOWNED</div><div class="v">' + p.deaths + '</div>' +
            '<div class="k">EXP TO NEXT</div><div class="v">' +
              (p.level >= Levels.MAX_LEVEL ? '—' : U.fmt(Math.max(0, p.expToNext - p.exp))) + '</div>' +
          '</div>' +
          '<div class="section-h">NEXT MILESTONES</div>' +
          (p.lockedAbilities().length
            ? p.lockedAbilities().map((a) =>
                '<div class="ability-item locked">' +
                  '<div class="ai-ico">' + a.icon + '</div>' +
                  '<div><div class="ai-name">' + a.name.toUpperCase() + '</div>' +
                  '<div class="ai-desc">Unlocks at level ' + a.unlockLevel +
                    ' — ' + U.fmt(Math.max(0, Levels.totalExpTo(a.unlockLevel) - Levels.totalExpTo(p.level) - p.exp)) +
                    ' EXP away.</div></div>' +
                '</div>').join('')
            : '<div class="sd-empty">Every ability unlocked. Go break something.</div>');
      } else {
        body.innerHTML =
          '<div class="section-h">CONTROLS</div>' +
          '<div class="kv">' +
            '<div class="k">MOVE</div><div class="v">A / D</div>' +
            '<div class="k">RUN</div><div class="v">Hold SHIFT while moving</div>' +
            '<div class="k">JUMP</div><div class="v">W — fixed height, all platforms are solid</div>' +
            '<div class="k">ATTACK</div><div class="v">LEFT MOUSE — aims at the cursor</div>' +
            '<div class="k">ABILITIES</div><div class="v">Q · E · R · C · V · X</div>' +
            '<div class="k">ABILITY LIST</div><div class="v">TAB — names, keys and cooldowns</div>' +
            '<div class="k">FLY</div><div class="v">Double-tap W — Wind, Fire, Lightning and Rain, from level 10</div>' +
            '<div class="k">FLY CONTROLS</div><div class="v">W up · S down · A / D steer</div>' +
            '<div class="k">INTERACT</div><div class="v">F — portals</div>' +
            '<div class="k">MENU</div><div class="v">ESC</div>' +
          '</div>' +
          '<div class="section-h">DEVELOPER TOOLS <span class="pill" style="margin-left:8px">DEBUG</span></div>' +
          '<div class="kv">' +
            '<div class="k">F1</div><div class="v">Toggle debug overlay</div>' +
            '<div class="k">F2</div><div class="v">Grant EXP (+1 level worth)</div>' +
            '<div class="k">F3</div><div class="v">Level up</div>' +
            '<div class="k">F4</div><div class="v">Jump to level 30 (unlock everything)</div>' +
            '<div class="k">F6</div><div class="v">Full heal</div>' +
            '<div class="k">F7</div><div class="v">+500 meat</div>' +
          '</div>' +
          '<div class="sd-empty" style="padding-top:14px;text-align:left">' +
          'Developer shortcuts are for testing only — remove the DEV block in game.js to disable them.</div>';
      }
    }

    /* ---- debug ------------------------------------------------------------ */

    setDebug(text) {
      this.e.debug.textContent = text;
    }
    toggleDebug() {
      this.e.debug.classList.toggle('hidden');
      return !this.e.debug.classList.contains('hidden');
    }
  }

  PF.UI = UI;
})(window.PF);
