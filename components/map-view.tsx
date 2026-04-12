// Base file - Metro resolves .web.tsx on web and .native.tsx on native.
// This file serves as fallback and should match the web version.
import React, { forwardRef } from 'react';
import { View, StyleSheet } from 'react-native';

export interface MapRegion {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

// Stub components for web
export const Marker = (_props: any) => null;
export const Circle = (_props: any) => null;
export const Callout = ({ children }: any) => <>{children}</>;

interface WebMapProps {
  initialRegion?: MapRegion;
  children?: React.ReactNode;
  showsUserLocation?: boolean;
  showsMyLocationButton?: boolean;
  showsCompass?: boolean;
  style?: any;
}

const WebMapView = forwardRef<any, WebMapProps>((props, ref) => {
  return <View style={[StyleSheet.absoluteFillObject, props.style]} />;
});

WebMapView.displayName = 'WebMapView';

export default WebMapView;
export const isNativeMap = false;
