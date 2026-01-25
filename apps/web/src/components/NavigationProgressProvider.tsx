'use client';

import NProgress from 'nprogress';
import { createContext, useCallback, useContext, useRef } from 'react';

// NProgress設定
NProgress.configure({
  showSpinner: false,
  minimum: 0.1,
  trickleSpeed: 200,
});

interface NavigationProgressContextType {
  startProgress: () => void;
  doneProgress: () => void;
}

const NavigationProgressContext = createContext<NavigationProgressContextType>({
  startProgress: () => {},
  doneProgress: () => {},
});

export function useNavigationProgress() {
  return useContext(NavigationProgressContext);
}

export function NavigationProgressProvider({ children }: { children: React.ReactNode }) {
  const isNavigatingRef = useRef(false);

  const startProgress = useCallback(() => {
    isNavigatingRef.current = true;
    NProgress.start();
  }, []);

  const doneProgress = useCallback(() => {
    if (isNavigatingRef.current) {
      NProgress.done();
      isNavigatingRef.current = false;
    }
  }, []);

  return (
    <NavigationProgressContext.Provider value={{ startProgress, doneProgress }}>
      {children}
    </NavigationProgressContext.Provider>
  );
}
