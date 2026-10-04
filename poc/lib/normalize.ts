import { z } from "zod";

export const RawListingSchema = z.object({
  id: z.string(),
  source: z.string(),
  title: z.string(),
  price: z.number().nullable(),
  currency: z.string().default("FCFA"),
  zone: z.string().nullable(),
  vendor: z.string().nullable(),
  url: z.string().nullable(),
  photo: z.string().nullable(),
  date: z.string().nullable(),
  description: z.string().nullable(),
});
export type RawListing = z.infer<typeof RawListingSchema>;

export const ExtractionSchema = z.object({
  listings: z.array(
    z.object({
      title: z.string(),
      price: z.number().nullable(),
      currency: z.string().nullable().default("FCFA"),
      zone: z.string().nullable(),
      vendor: z.string().nullable(),
      url: z.string().nullable(),
      photo: z.string().nullable(),
      date: z.string().nullable(),
      description: z.string().nullable(),
    }),
  ),
});

export const ScoreSchema = z.object({
  scores: z.array(
    z.object({
      idx: z.number().int().min(0),
      score: z.number().min(0).max(1),
      criteres: z
        .array(
          z.object({
            nom: z.string(),
            valeur: z.string().nullable().default(null),
            extrait: z.string().nullable().default(null),
          }),
        )
        .nullable()
        .default([]),
    }),
  ),
});
export type ScoredItem = z.infer<typeof ScoreSchema>["scores"][number];

export const PageExtractionSchema = z.object({
  title: z.string().nullable().default(null),
  price: z.number().nullable().default(null),
  currency: z.string().nullable().default("FCFA"),
  zone: z.string().nullable().default(null),
  vendor: z.string().nullable().default(null),
  date: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  isListing: z.boolean().default(true),
});