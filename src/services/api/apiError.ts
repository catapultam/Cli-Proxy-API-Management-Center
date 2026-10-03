import axios from 'axios';
import { isRecord } from '@/utils/helpers';
import type { ApiError } from '@/types';

export interface ParsedApiErrorResponse {
  message: string;
  apiCode?: string;
}

const readString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Parse the Management API's error envelope.
 *
 * Newer endpoints use `error` as a stable machine-readable code and `message`
 * as the human-readable detail. Older endpoints may put the only useful text
 * directly in `error`, so that remains a fallback.
 */
export const parseApiErrorResponse = (
  responseData: unknown,
  fallbackMessage: string
): ParsedApiErrorResponse => {
  if (!isRecord(responseData)) {
    return {
      message: readString(responseData) || readString(fallbackMessage) || 'Request failed',
    };
  }

  const errorValue = responseData.error;
  const errorRecord = isRecord(errorValue) ? errorValue : null;
  const stringError = readString(errorValue);
  const apiCode = stringError || readString(errorRecord?.code) || undefined;
  const message =
    readString(responseData.message) ||
    readString(errorRecord?.message) ||
    stringError ||
    readString(fallbackMessage) ||
    'Request failed';

  return { message, apiCode };
};

/**
 * Normalize any thrown value (typically an Axios error) into the shared `ApiError` shape.
 * Shared by `apiClient` and the pre-authentication session endpoints so callers get a
 * consistent `{ status, code, apiCode, message, details }` error regardless of caller.
 */
export const toApiError = (error: unknown): ApiError => {
  if (axios.isAxiosError(error)) {
    const responseData: unknown = error.response?.data;
    const parsedError = parseApiErrorResponse(responseData, error.message);
    const apiError = new Error(parsedError.message) as ApiError;
    apiError.name = 'ApiError';
    apiError.status = error.response?.status;
    apiError.code = error.code;
    apiError.apiCode = parsedError.apiCode;
    apiError.details = responseData;
    apiError.data = responseData;
    return apiError;
  }

  const fallbackMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error occurred';
  const fallback = new Error(fallbackMessage) as ApiError;
  fallback.name = 'ApiError';
  return fallback;
};
