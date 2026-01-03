'use client';

import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

type ProgressState = 'idle' | 'loading' | 'completing';

interface NavigationProgressContextType {
  startProgress: () => void;
}

const NavigationProgressContext = createContext<NavigationProgressContextType>({
  startProgress: () => {},
});

export function useNavigationProgress() {
  return useContext(NavigationProgressContext);
}

interface NavigationProgressProviderProps {
  children: React.ReactNode;
}

export function NavigationProgressProvider({
  children,
}: NavigationProgressProviderProps) {
  const [state, setState] = useState<ProgressState>('idle');
  const pathname = usePathname();
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    void pathname; // ナビゲーション完了検知用
    if (stateRef.current === 'loading') {
      setState('completing');
      timeoutRef.current = setTimeout(() => {
        setState('idle');
      }, 300);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [pathname]);

  const startProgress = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setState('loading');
  }, []);

  return (
    <NavigationProgressContext.Provider value={{ startProgress }}>
      {state !== 'idle' && (
        <div
          className={`navigation-progress ${state === 'loading' ? 'loading' : 'complete'}`}
        />
      )}
      {children}
    </NavigationProgressContext.Provider>
  );
}
