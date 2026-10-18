import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { PRINT_DOCS, PrintDoc } from './print.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * How one printed document looks: its title, extra text above and below, empty spaces to fill in by hand,
 * and the signature lines. Everything is optional; empty = the built-in wording.
 */
export class DocTemplateDto {
  /** Replaces the heading, e.g. "НЭХЭМЖЛЭХ" → "НЭХЭМЖЛЭЛ №". */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  title?: string;

  /** Printed under the heading (terms, a notice…). */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(600)
  headerNote?: string;

  /** Printed at the bottom, above the signatures. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(800)
  footerNote?: string;

  /** Leave the buyer's details as empty lines to write by hand. */
  @IsOptional()
  @IsBoolean()
  blankBuyer?: boolean;

  /** Extra empty table rows after the goods, to add lines by hand. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  blankRows?: number;

  /** Signature lines, e.g. ["Нягтлан", "Хүлээн авсан"]; empty = the default ones. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  signatures?: string[];

  /** Show the "stamp here" (Тэмдэг) box. */
  @IsOptional()
  @IsBoolean()
  stamp?: boolean;

  /** Show unit prices and amounts (issue notes can go to the warehouse without prices). */
  @IsOptional()
  @IsBoolean()
  showPrices?: boolean;

  /** Optional parts switched off in the template editor (part keys such as "cashier", "watermark"). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @MaxLength(30, { each: true })
  hidden?: string[];
}

export class DocTemplatesDto {
  @IsOptional() @ValidateNested() @Type(() => DocTemplateDto) invoice?: DocTemplateDto;
  @IsOptional() @ValidateNested() @Type(() => DocTemplateDto) receipt?: DocTemplateDto;
  @IsOptional() @ValidateNested() @Type(() => DocTemplateDto) issueNote?: DocTemplateDto;
  @IsOptional() @ValidateNested() @Type(() => DocTemplateDto) picklist?: DocTemplateDto;
}

export type DocTemplate = {
  title: string;
  headerNote: string;
  footerNote: string;
  blankBuyer: boolean;
  blankRows: number;
  signatures: string[];
  stamp: boolean;
  showPrices: boolean;
  hidden: string[];
};

export const DEFAULT_TEMPLATE: Record<PrintDoc, DocTemplate> = {
  invoice: { title: '', headerNote: '', footerNote: '', blankBuyer: false, blankRows: 0, signatures: ['Нэхэмжилсэн', 'Хүлээн авсан'], stamp: true, showPrices: true, hidden: [] },
  receipt: { title: '', headerNote: '', footerNote: '', blankBuyer: false, blankRows: 0, signatures: [], stamp: false, showPrices: true, hidden: [] },
  issueNote: { title: '', headerNote: '', footerNote: '', blankBuyer: false, blankRows: 0, signatures: ['Олгосон (нярав)', 'Хүлээн авсан', 'Шалгасан'], stamp: false, showPrices: true, hidden: [] },
  picklist: { title: '', headerNote: '', footerNote: '', blankBuyer: false, blankRows: 0, signatures: ['Бэлтгэсэн', 'Шалгасан', 'Хүлээн авсан'], stamp: false, showPrices: false, hidden: [] },
};

export { PRINT_DOCS };
