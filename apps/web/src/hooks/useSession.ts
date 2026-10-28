import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, type AuthUser } from '@tyde/shared';
import { api } from '../services/api';
export const SESSION_KEY = ['session'] as const;
export const sessionQuery = {
  queryKey: SESSION_KEY,
  queryFn: async (): Promise<AuthUser | null> => {
    try {
      return await api.getCurrentUser();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },
};

function temporaryFailure(error: unknown) {
  return (
    error instanceof ApiError &&
    error.code !== 'INVALID_RESPONSE' &&
    (error.status === 0 || (error.status >= 500 && error.status < 600))
  );
}

export function useSession() {
  const cache = useQueryClient();
  return useQuery({
    ...sessionQuery,
    retry: (count, error) =>
      !cache.getQueryData(SESSION_KEY) && count < 1 && temporaryFailure(error),
    retryDelay: 3000,
    refetchInterval: ({ state }) => (state.data && temporaryFailure(state.error) ? 3000 : false),
    refetchIntervalInBackground: true,
  });
}
