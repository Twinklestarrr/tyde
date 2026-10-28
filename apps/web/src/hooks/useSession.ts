import { useQuery } from '@tanstack/react-query';
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

export function useSession() {
  return useQuery({
    ...sessionQuery,
    refetchInterval: ({ state }) => {
      const error = state.error;
      if (error && !state.data) return 3000;
      return error instanceof ApiError &&
        error.code !== 'INVALID_RESPONSE' &&
        (error.status === 0 || (error.status >= 500 && error.status < 600))
        ? 3000
        : false;
    },
    refetchIntervalInBackground: true,
  });
}
