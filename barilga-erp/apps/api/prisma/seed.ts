import { PrismaClient, Role, VehicleCode, ZoneCode } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('Barilga123!', 12);

  const users: Array<{ username: string; email: string; fullName: string; role: Role }> = [
    { username: 'admin', email: 'admin@barilga.mn', fullName: 'Системийн админ', role: Role.ADMIN },
    { username: 'manager', email: 'manager@barilga.mn', fullName: 'Гантулга', role: Role.MANAGER },
    { username: 'cashier', email: 'cashier@barilga.mn', fullName: 'Оюунчимэг', role: Role.BORLUULAGCH },
    { username: 'warehouse', email: 'warehouse@barilga.mn', fullName: 'Төмөрбаатар', role: Role.ACHIGCH_BELTGEGCH },
  ];

  for (const u of users) {
    await prisma.user.upsert({
      where: { username: u.username },
      update: { email: u.email, fullName: u.fullName, role: u.role, passwordHash, isActive: true },
      create: { ...u, passwordHash },
    });
  }

  const webshopHash = await bcrypt.hash(`${Date.now()}-${Math.random()}`, 12);
  await prisma.user.upsert({
    where: { username: 'webshop' },
    update: {
      email: 'web@barilga.mn',
      fullName: 'Цахим захиалга',
      role: Role.BORLUULAGCH,
      isActive: true,
    },
    create: {
      username: 'webshop',
      email: 'web@barilga.mn',
      fullName: 'Цахим захиалга',
      role: Role.BORLUULAGCH,
      passwordHash: webshopHash,
    },
  });

  const zones = [
    {
      code: ZoneCode.ZONE_A,
      nameMn: 'Хотын төв',
      nameEn: 'Zone A — City center',
      description: 'Ulaanbaatar downtown districts (Сүхбаатар, Чингэлтэй, Баянгол төв).',
      baseDeliveryFeeMnt: 25_000,
      nightDiscountApplies: true,
      sortOrder: 1,
    },
    {
      code: ZoneCode.ZONE_B,
      nameMn: 'Алслагдсан дүүрэг',
      nameEn: 'Zone B — Outer districts',
      description: 'SХД, БЗД, БГД захын хороо, Налайх чиглэл.',
      baseDeliveryFeeMnt: 45_000,
      nightDiscountApplies: true,
      sortOrder: 2,
    },
    {
      code: ZoneCode.ZONE_RESORT,
      nameMn: 'Зуслан',
      nameEn: 'Zone Resort',
      description: 'Seasonal cottage / зуслан belts around UB.',
      baseDeliveryFeeMnt: 70_000,
      nightDiscountApplies: true,
      sortOrder: 3,
    },
    {
      code: ZoneCode.RURAL_TERMINAL,
      nameMn: 'Хөдөө орон нутаг / Драгон, Вокзал',
      nameEn: 'Rural terminal (Dragon, Vokzal)',
      description: 'Intercity bus terminals. Night discount does not apply.',
      baseDeliveryFeeMnt: 40_000,
      nightDiscountApplies: false,
      sortOrder: 4,
    },
  ];

  for (const z of zones) {
    await prisma.zone.upsert({
      where: { code: z.code },
      update: z,
      create: z,
    });
  }

  const vehicles = [
    {
      code: VehicleCode.PORTER,
      nameMn: 'Портер',
      nameEn: 'Porter',
      maxWeightKg: 1_500,
      maxLengthM: 3.5,
      maxVolumeM3: 8,
      sortOrder: 1,
    },
    {
      code: VehicleCode.DUMP,
      nameMn: 'Өөрөө буулгагч',
      nameEn: 'Dump truck',
      maxWeightKg: 5_000,
      maxLengthM: 6,
      maxVolumeM3: 20,
      sortOrder: 2,
    },
    {
      code: VehicleCode.MANIPULATOR,
      nameMn: 'Манипулятор',
      nameEn: 'Manipulator',
      maxWeightKg: 10_000,
      maxLengthM: 12,
      maxVolumeM3: 40,
      sortOrder: 3,
    },
  ];

  for (const v of vehicles) {
    await prisma.vehicleType.upsert({
      where: { code: v.code },
      update: v,
      create: v,
    });
  }

  const products = [
    { sku: 'CEM-42.5-50', category: 'Cement', nameMn: 'Цемент М400 50кг', nameEn: 'Cement 42.5 50kg', unit: 'bag', priceMnt: 18_500, weightKg: 50, lengthM: 0.6, volumeM3: 0.033, stockQty: 4000, minStockLevel: 200, imageUrl: 'https://placehold.co/480x360/1c2630/e8b923.png?text=Cement', description: 'Portland cement for foundations and slabs' },
    { sku: 'REB-12-12', category: 'Steel', nameMn: 'Арматур Ø12 12м', nameEn: 'Rebar 12mm 12m', unit: 'bar', priceMnt: 32_000, weightKg: 10.66, lengthM: 12, volumeM3: 0.0014, stockQty: 800, minStockLevel: 80, imageUrl: 'https://placehold.co/480x360/1c2630/e8b923.png?text=Rebar+12', description: 'Deformed steel bar for columns' },
    { sku: 'REB-16-12', category: 'Steel', nameMn: 'Арматур Ø16 12м', nameEn: 'Rebar 16mm 12m', unit: 'bar', priceMnt: 56_000, weightKg: 18.96, lengthM: 12, volumeM3: 0.0024, stockQty: 600, minStockLevel: 60, imageUrl: 'https://placehold.co/480x360/1c2630/e8b923.png?text=Rebar+16' },
    { sku: 'BRK-RED', category: 'Masonry', nameMn: 'Улаан тоосго', nameEn: 'Red brick', unit: 'pcs', priceMnt: 450, weightKg: 3.5, lengthM: 0.25, volumeM3: 0.002, stockQty: 50000, minStockLevel: 5000, imageUrl: 'https://placehold.co/480x360/1c2630/e8b923.png?text=Brick' },
    { sku: 'SND-M3', category: 'Aggregates', nameMn: 'Элс', nameEn: 'Sand', unit: 'm³', priceMnt: 45_000, weightKg: 1600, lengthM: 1, volumeM3: 1, stockQty: 200, minStockLevel: 30, imageUrl: 'https://placehold.co/480x360/1c2630/e8b923.png?text=Sand' },
    { sku: 'GRV-M3', category: 'Aggregates', nameMn: 'Хайрга 10-20', nameEn: 'Gravel 10-20', unit: 'm³', priceMnt: 52_000, weightKg: 1650, lengthM: 1, volumeM3: 1, stockQty: 180, minStockLevel: 200, imageUrl: 'https://placehold.co/480x360/1c2630/e8b923.png?text=Gravel' },
    { sku: 'BLK-190', category: 'Masonry', nameMn: 'Хөөсөн блок 190мм', nameEn: 'AAC block 190mm', unit: 'pcs', priceMnt: 6_800, weightKg: 18, lengthM: 0.6, volumeM3: 0.0228, stockQty: 3000, minStockLevel: 200, imageUrl: 'https://placehold.co/480x360/1c2630/e8b923.png?text=Block' },
    { sku: 'PLY-18', category: 'Wood', nameMn: 'Фанер 18мм', nameEn: 'Plywood 18mm', unit: 'sheet', priceMnt: 48_000, weightKg: 22, lengthM: 2.44, volumeM3: 0.054, stockQty: 400, minStockLevel: 400, imageUrl: 'https://placehold.co/480x360/1c2630/e8b923.png?text=Plywood' },
  ];

  // The migration normally creates the default warehouse; a database built from scratch by seed gets it here.
  const defaultWarehouse =
    (await prisma.warehouse.findFirst({ where: { isDefault: true } })) ??
    (await prisma.warehouse.create({ data: { code: 'MAIN', name: 'Үндсэн агуулах', isDefault: true } }));

  for (const p of products) {
    const { stockQty, ...catalog } = p;
    const existing = await prisma.product.findUnique({ where: { sku: p.sku } });
    if (existing) {
      // Re-seeding never touches quantities: those are owned by the stock ledger now.
      await prisma.product.update({ where: { sku: p.sku }, data: catalog });
      continue;
    }
    await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({ data: p });
      await tx.stockBalance.create({
        data: { warehouseId: defaultWarehouse.id, productId: created.id, quantity: stockQty },
      });
      await tx.stockMovement.create({
        data: {
          warehouseId: defaultWarehouse.id,
          productId: created.id,
          type: 'OPENING',
          quantityDelta: stockQty,
          balanceAfter: stockQty,
          refType: 'SEED',
          reason: 'Demo opening balance',
        },
      });
    });
  }

  console.log('Seed complete. Demo password for all users: Barilga123!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
