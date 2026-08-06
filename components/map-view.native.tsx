import React, { forwardRef } from 'react';
import MapView, { Marker, Circle, Polyline, Callout } from 'react-native-maps';
import { View, Text, StyleSheet } from 'react-native';

export { Marker, Circle, Polyline, Callout };

export interface MapRegion {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

interface NativeMapProps {
  initialRegion: MapRegion;
  children?: React.ReactNode;
  showsUserLocation?: boolean;
  showsMyLocationButton?: boolean;
  showsCompass?: boolean;
  onPress?: (e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => void;
  mapType?: 'standard' | 'satellite' | 'hybrid' | 'terrain';
  style?: any;
}

const NativeMapView = forwardRef<any, NativeMapProps>((props, ref) => {
  return (
    <MapView
      ref={ref}
      style={props.style || StyleSheet.absoluteFillObject}
      initialRegion={props.initialRegion}
      showsUserLocation={props.showsUserLocation}
      showsMyLocationButton={props.showsMyLocationButton}
      showsCompass={props.showsCompass}
      onPress={props.onPress}
      mapType={props.mapType}
    >
      {props.children}
    </MapView>
  );
});

NativeMapView.displayName = 'NativeMapView';

export default NativeMapView;
export const isNativeMap = true;
