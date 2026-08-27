declare module 'open-location-code' {
  export interface OpenLocationCodeArea {
    latitudeLo: number
    longitudeLo: number
    latitudeHi: number
    longitudeHi: number
    latitudeCenter: number
    longitudeCenter: number
    codeLength: number
  }

  export class OpenLocationCode {
    isValid(code: string): boolean
    isShort(code: string): boolean
    isFull(code: string): boolean
    encode(latitude: number, longitude: number, codeLength?: number): string
    decode(code: string): OpenLocationCodeArea
    shorten(code: string, latitude: number, longitude: number): string
    recoverNearest(code: string, latitude: number, longitude: number): string
  }
}
