import { req } from "./core";

export interface LivingCategory { id: number; name: string }

export const livingCategories = {
  list: (signal: AbortSignal) => req<LivingCategory[]>("/living-categories", { signal }),
  save: (name: string, id: number | null) => req<LivingCategory>(
    id === null ? "/living-categories" : `/living-categories/${id}`,
    { method: id === null ? "POST" : "PUT", body: JSON.stringify({ name }) },
  ),
};
