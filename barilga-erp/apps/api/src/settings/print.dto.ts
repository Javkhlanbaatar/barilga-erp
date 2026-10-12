import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min, ValidateNested } from 'class-validator';

export const PAPER_SIZES = ['A4', 'A5', '80MM'] as const;
export const ORIENTATIONS = ['portrait', 'landscape'] as const;
export const PRINT_DOCS = ['invoice', 'receipt', 'issueNote', 'picklist'] as const;

export type PaperSize = (typeof PAPER_SIZES)[number];
export type Orientation = (typeof ORIENTATIONS)[number];
export type PrintDoc = (typeof PRINT_DOCS)[number];

export class DocPrintDto {
  @IsIn(PAPER_SIZES)
  paper!: PaperSize;

  /** Ignored for 80mm roll paper. */
  @IsIn(ORIENTATIONS)
  orientation!: Orientation;

  /** How many copies the print page lays out (multi-part carbon paper needs 1). */
  @IsInt()
  @Min(1)
  @Max(5)
  copies!: number;
}

/** Paper layout per printed document, set once by an admin. */
export class PrintSettingsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => DocPrintDto)
  invoice?: DocPrintDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => DocPrintDto)
  receipt?: DocPrintDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => DocPrintDto)
  issueNote?: DocPrintDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => DocPrintDto)
  picklist?: DocPrintDto;
}
