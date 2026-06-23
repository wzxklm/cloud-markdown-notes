export type ApiSuccess<T> = {
  data: T;
};

export function apiSuccess<T>(data: T): ApiSuccess<T> {
  return { data };
}

export type HealthStatus = {
  status: "ok";
  appEnv: string;
  database: "ok";
  workspace: {
    root: string;
    writable: boolean;
  };
};
