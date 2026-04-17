import React, { createContext, useContext, useState, useCallback } from 'react';

interface UnreadContextType {
  totalUnread: number;
  setTotalUnread: (count: number) => void;
  decrementUnread: (count: number) => void;
}

const UnreadContext = createContext<UnreadContextType>({
  totalUnread: 0,
  setTotalUnread: () => {},
  decrementUnread: () => {},
});

export function UnreadProvider({ children }: { children: React.ReactNode }) {
  const [totalUnread, setTotalUnread] = useState(0);
  
  const decrementUnread = useCallback((count: number) => {
    setTotalUnread(prev => Math.max(0, prev - count));
  }, []);

  return (
    <UnreadContext.Provider value={{ totalUnread, setTotalUnread, decrementUnread }}>
      {children}
    </UnreadContext.Provider>
  );
}

export function useUnread() {
  return useContext(UnreadContext);
}
