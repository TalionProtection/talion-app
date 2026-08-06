import React, { forwardRef } from 'react';
import { View, StyleSheet } from 'react-native';

export interface MapRegion {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

// Stub components for web
export const Marker = ({ children }: any) => null;
export const Circle = (props: any) => null;
export const Polyline = (props: any) => null;
export const Callout = ({ children }: any) => <>{children}</>;

interface WebMapProps {
  initialRegion?: MapRegion;
  children?: React.ReactNode;
  showsUserLocation?: boolean;
  showsMyLocationButton?: boolean;
  showsCompass?: boolean;
  onPress?: (e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => void;
  mapType?: 'standard' | 'satellite' | 'hybrid' | 'terrain';
  style?: any;
}

const WebMapView = forwardRef<any, WebMapProps>((props, ref) => {
  // On web, we render nothing here - the parent will use WebMapView fallback
  return <View style={[StyleSheet.absoluteFillObject, props.style]} />;
});

WebMapView.displayName = 'WebMapView';

export default WebMapView;
export const isNativeMap = false;
