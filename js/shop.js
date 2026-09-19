/* ==========================================================================
   Power Forge — shop.js
   The meat shop: permanent, run-long upgrades bought with the meat you've
   collected (js/items.js drops it, player.js's meatCount holds it). One
   shared list for every power — nothing here is element-specific, unlike
   the per-power ability kits in abilities.js.

   Each entry's `apply(player)` runs once, at purchase — for a passive stat
   like regen that just means bumping a running total rather than pushing a
   temporary buff, so it survives exactly like every other permanent stat
   the player has (i.e. forever, for the rest of THIS run — see the title
   screen's "session progress only").
   ========================================================================== */
(function (PF) {
  'use strict';

  const SHOP_ITEMS = [
    {
      id: 'infiniteRegen',
      name: 'Auto Heal',
      icon: '❤',
      cost: 200,
      desc: 'Heal 5 health every second for the rest of the run.',
      apply(player) { player.permRegenRate += 5; }
    }
  ];

  PF.Shop = { items: SHOP_ITEMS };
})(window.PF);
