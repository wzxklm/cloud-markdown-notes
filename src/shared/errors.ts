export const errorCodes = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "USER_PENDING",
  "USER_ALREADY_EXISTS",
  "USER_NOT_FOUND",
  "INVALID_CREDENTIALS",
  "VALIDATION_ERROR",
  "PATH_INVALID",
  "PATH_NOT_FOUND",
  "PATH_ALREADY_EXISTS",
  "NOTE_LIMIT_EXCEEDED",
  "EDIT_CONFLICT",
  "COMMIT_MESSAGE_REQUIRED",
  "NO_CHANGES_TO_COMMIT",
  "IMPORT_CONFLICT",
  "GLOB_INVALID",
  "REGEX_INVALID",
  "NOTE_NOT_COMMITTED",
  "SHARE_NOT_FOUND",
  "INTERNAL_ERROR"
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export type ApiError = {
  error: {
    code: ErrorCode;
    message: string;
  };
};

export function apiError(code: ErrorCode, message: string): ApiError {
  return {
    error: {
      code,
      message
    }
  };
}
