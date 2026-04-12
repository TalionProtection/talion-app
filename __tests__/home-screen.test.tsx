import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react-native';
import HomeScreen from './index';
import * as AuthContext from '@/lib/auth-context';

// Mock the auth context
vi.mock('@/lib/auth-context', () => ({
  useAuth: vi.fn(),
}));

// Mock other components
vi.mock('@/components/themed-view', () => ({
  ThemedView: ({ children }: any) => <>{children}</>,
}));

vi.mock('@/components/themed-text', () => ({
  ThemedText: ({ children }: any) => <>{children}</>,
}));

vi.mock('@/components/sos-button', () => ({
  SOSButton: () => <div testID="sos-button">SOS Button</div>,
}));

vi.mock('@/components/alert-creation-modal', () => ({
  AlertCreationModal: () => <div testID="alert-modal">Alert Modal</div>,
}));

describe('HomeScreen - SOS Button Visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should display SOS button for user role', () => {
    // Mock user role
    (AuthContext.useAuth as any).mockReturnValue({
      user: { id: '1', email: 'user@talion.com', role: 'user', name: 'Test User' },
      isSignedIn: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      signup: vi.fn(),
    });

    render(<HomeScreen />);
    
    // Check if SOS button is rendered
    const sosButton = screen.getByTestID('sos-button');
    expect(sosButton).toBeDefined();
  });

  it('should display SOS button for responder role', () => {
    // Mock responder role
    (AuthContext.useAuth as any).mockReturnValue({
      user: { id: '2', email: 'responder@talion.com', role: 'responder', name: 'Test Responder', status: 'available' },
      isSignedIn: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      signup: vi.fn(),
    });

    render(<HomeScreen />);
    
    // Check if SOS button is rendered
    const sosButton = screen.getByTestID('sos-button');
    expect(sosButton).toBeDefined();
  });

  it('should display SOS button for dispatcher role', () => {
    // Mock dispatcher role
    (AuthContext.useAuth as any).mockReturnValue({
      user: { id: '3', email: 'dispatcher@talion.com', role: 'dispatcher', name: 'Test Dispatcher' },
      isSignedIn: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      signup: vi.fn(),
    });

    render(<HomeScreen />);
    
    // Check if SOS button is rendered
    const sosButton = screen.getByTestID('sos-button');
    expect(sosButton).toBeDefined();
  });

  it('should display Create Alert button only for user role', () => {
    // Mock user role
    (AuthContext.useAuth as any).mockReturnValue({
      user: { id: '1', email: 'user@talion.com', role: 'user', name: 'Test User' },
      isSignedIn: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      signup: vi.fn(),
    });

    const { getByText } = render(<HomeScreen />);
    
    // Check if Create Alert button is rendered for users
    const createAlertButton = getByText('Create Alert');
    expect(createAlertButton).toBeDefined();
  });

  it('should NOT display Create Alert button for responder role', () => {
    // Mock responder role
    (AuthContext.useAuth as any).mockReturnValue({
      user: { id: '2', email: 'responder@talion.com', role: 'responder', name: 'Test Responder', status: 'available' },
      isSignedIn: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      signup: vi.fn(),
    });

    const { queryByText } = render(<HomeScreen />);
    
    // Check if Create Alert button is NOT rendered for responders
    const createAlertButton = queryByText('Create Alert');
    expect(createAlertButton).toBeNull();
  });

  it('should NOT display Create Alert button for dispatcher role', () => {
    // Mock dispatcher role
    (AuthContext.useAuth as any).mockReturnValue({
      user: { id: '3', email: 'dispatcher@talion.com', role: 'dispatcher', name: 'Test Dispatcher' },
      isSignedIn: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      signup: vi.fn(),
    });

    const { queryByText } = render(<HomeScreen />);
    
    // Check if Create Alert button is NOT rendered for dispatchers
    const createAlertButton = queryByText('Create Alert');
    expect(createAlertButton).toBeNull();
  });
});
