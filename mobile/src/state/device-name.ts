import Constants from "expo-constants";
import { Platform } from "react-native";
import { deviceDescriptionFrom, type DeviceDescription } from "../transport/device-describe";

/** This phone, as the Mac lists it (`device.describe`). */
export const currentDeviceDescription = (): DeviceDescription | null => deviceDescriptionFrom(Platform.OS, Platform.constants, Constants.deviceName);
