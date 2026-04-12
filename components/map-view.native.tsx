import React, { forwardRef } from 'react';
import MapView, { Marker, Circle, Callout } from 'react-native-maps';
import { View, Text, StyleSheet } from 'react-native';

export { Marker, Circle, Callout };

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
    >
      {props.children}
    </MapView>
  );
});

NativeMapView.displayName = 'NativeMapView';

export default NativeMapView;
export const isNativeMap = true;
