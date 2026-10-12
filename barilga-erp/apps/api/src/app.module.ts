import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { CashModule } from './cash/cash.module';
import { CatalogModule } from './catalog/catalog.module';
import { CustomersModule } from './customers/customers.module';
import { EbarimtModule } from './ebarimt/ebarimt.module';
import { FeaturesModule } from './features/features.module';
import { HealthController } from './health.controller';
import { HrModule } from './hr/hr.module';
import { InventoryModule } from './inventory/inventory.module';
import { LogisticsModule } from './logistics/logistics.module';
import { OrdersModule } from './orders/orders.module';
import { PublicModule } from './public/public.module';
import { PaymentModule } from './payment/payment.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReportsModule } from './reports/reports.module';
import { ReturnsModule } from './returns/returns.module';
import { SettingsModule } from './settings/settings.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../.env'] }),
    ScheduleModule.forRoot(),
    PrismaModule,
    FeaturesModule,
    AuthModule,
    CustomersModule,
    UsersModule,
    CatalogModule,
    InventoryModule,
    LogisticsModule,
    EbarimtModule,
    PaymentModule,
    OrdersModule,
    PublicModule,
    ReturnsModule,
    ReportsModule,
    HrModule,
    CashModule,
    SettingsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
