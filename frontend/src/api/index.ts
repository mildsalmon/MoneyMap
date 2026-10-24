export * from "./types";
export { ApiError } from "./core";
export * from "./accountTree";
export * from "./chartToggles";
import { installmentsApi } from "./installments";
import { statusApi } from "./status";
import { accountsApi } from "./accounts";
import { transactionsApi } from "./transactions";
import { rulesApi } from "./rules";
import { scenariosApi } from "./scenarios";
import { reportingApi } from "./reporting";

export const api = {
  ...installmentsApi,
  ...statusApi,
  ...accountsApi,
  ...transactionsApi,
  ...rulesApi,
  ...scenariosApi,
  ...reportingApi,
};
