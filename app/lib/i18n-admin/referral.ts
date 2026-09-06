// Admin-only i18n strings for the Referral Commission control panel.
// Namespace: "admin.referral.*" — owned exclusively by this file. Merged into
// app/lib/i18n.ts's STRINGS dict by hand.
export const ADMIN_REFERRAL_STRINGS = {
  "admin.referral.title": { lo: "ຄອມມິຊັນແນະນໍາເພື່ອນ", en: "Referral Commission" },

  "admin.referral.status.on": { lo: "ເປີດໃຊ້ງານ", en: "ACTIVE" },
  "admin.referral.status.off": { lo: "ປິດການໃຊ້ງານ", en: "DISABLED" },

  "admin.referral.panel.heading": { lo: "ຕັ້งຄ່າແຄມເປນ", en: "Campaign settings" },
  "admin.referral.panel.descOn": {
    lo: "ຜູ້ແນະນໍາຈະໄດ້ຮັບ {percent}% ຂອງທຸກລາຍການຝາກເງິນທີ່ຜູ້ຖືກແນະນໍາຝາກສຳເລັດ — ຕະຫຼອດໄປ ຈົນກວ່າແອັດມິນຈະປິດແຄມເປນນີ້.",
    en: "Referrers earn {percent}% of every deposit their referrals make — recurring, until you disable this campaign.",
  },
  "admin.referral.panel.descOff": {
    lo: "ບໍ່ມີຄອມມິຊັນຖືກຈ່າຍໃນຂະນະນີ້. ຕັ້ງເປີເຊັນ ແລ້ວກົດເປີດໃຊ້ງານເພື່ອເລີ່ມແຄມເປນ.",
    en: "No commission is being paid right now. Set a percentage and enable to start the campaign.",
  },

  "admin.referral.form.percentLabel": { lo: "ເປີເຊັນຄອມມິຊັນ", en: "Commission percentage" },
  "admin.referral.form.percentHint": { lo: "ຂອງຍອດຝາກເງິນທີ່ອະນຸມັດ ຕໍ່ຄັ້ງ", en: "of each approved deposit amount" },
  "admin.referral.form.save": { lo: "ບັນທຶກເປີເຊັນ", en: "Save percentage" },
  "admin.referral.form.saving": { lo: "ກຳລັງບັນທຶກ...", en: "Saving..." },

  "admin.referral.enable": { lo: "ເປີດໃຊ້ງານແຄມເປນ", en: "Enable campaign" },
  "admin.referral.disable": { lo: "ປິດແຄມເປນ", en: "Disable campaign" },

  "admin.referral.confirmEnable.title": { lo: "ເປີດໃຊ້ງານຄອມມິຊັນແນະນໍາ?", en: "Enable referral commission?" },
  "admin.referral.confirmEnable.body": {
    lo: "ຜູ້ແນະນໍາທຸກຄົນຈະເລີ່ມໄດ້ຮັບ {percent}% ຂອງທຸກລາຍການຝາກເງິນຂອງຜູ້ຖືກແນະນໍາ ທັນທີ ແລະ ຈະສືບຕໍ່ຈົນກວ່າທ່ານຈະປິດແຄມເປນນີ້.",
    en: "Every referrer will immediately start earning {percent}% of every deposit their referrals make, continuing until you disable this campaign.",
  },
  "admin.referral.confirmDisable.title": { lo: "ປິດແຄມເປນຄອມມິຊັນແນະນໍາ?", en: "Disable referral commission?" },
  "admin.referral.confirmDisable.body": {
    lo: "ຈະບໍ່ມີການຈ່າຍຄອມມິຊັນໃໝ່ອີກ ຈົນກວ່າທ່ານຈະເປີດໃຊ້ງານຄືນ. ຄອມມິຊັນທີ່ຈ່າຍໄປແລ້ວຈະບໍ່ຖືກເອີ້ນຄືນ.",
    en: "No new commission will be paid until you turn this back on. Commission already paid out is not clawed back.",
  },
  "admin.referral.confirm.cancel": { lo: "ຍົກເລີກ", en: "Cancel" },
  "admin.referral.confirm.confirm": { lo: "ຢືນຢັນ", en: "Confirm" },
  "admin.referral.confirm.confirming": { lo: "ກຳລັງດຳເນີນການ...", en: "Working..." },

  "admin.referral.stats.totalPaid": { lo: "ຈ່າຍໄປທັງໝົດ", en: "Total paid out" },
  "admin.referral.stats.totalReferred": { lo: "ຜູ້ຖືກແນະນໍາທັງໝົດ", en: "Total referred users" },
  "admin.referral.stats.activeReferrers": { lo: "ຜູ້ແນະນໍາທີ່ໄດ້ຄອມມິຊັນ", en: "Earning referrers" },

  "admin.referral.leaderboard.heading": { lo: "ອັນດັບຜູ້ແນະນໍາ (ຄອມມິຊັນສູງສຸດ)", en: "Top referrers by commission earned" },
  "admin.referral.leaderboard.empty": { lo: "ຍັງບໍ່ມີການຈ່າຍຄອມມິຊັນ", en: "No commission paid out yet" },
  "admin.referral.leaderboard.col.player": { lo: "ຜູ້ແນະນໍາ", en: "Referrer" },
  "admin.referral.leaderboard.col.referrals": { lo: "ຈຳນວນຄົນທີ່ແນະນໍາ", en: "Referrals" },
  "admin.referral.leaderboard.col.payouts": { lo: "ຈຳນວນຄັ້ງທີ່ໄດ້ຮັບ", en: "Payouts" },
  "admin.referral.leaderboard.col.totalEarned": { lo: "ຄອມມິຊັນລວມ", en: "Total earned" },

  "admin.referral.err.insufficientPermissions": { lo: "ທ່ານບໍ່ມີສິດອະນຸຍາດໃຫ້ດຳເນີນການນີ້", en: "You do not have permission to do this" },
  "admin.referral.err.invalidPercent": { lo: "ເປີເຊັນຕ້ອງຢູ່ລະຫວ່າງ 1 ຫາ 100", en: "Percentage must be between 1 and 100" },
  "admin.referral.err.unknownOp": { lo: "ຄຳສັ່ງບໍ່ຖືກຕ້ອງ", en: "Unknown action" },
} as const
