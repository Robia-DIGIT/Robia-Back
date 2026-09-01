import { Injectable } from '@nestjs/common';

export interface CurrentWeather {
  temperatureC: number;
  precipitationMm: number;
  windSpeedKmh: number;
  weatherCode: number;
  description: string;
  isDay: boolean;
  observedAt: string;
}

// Codes WMO (norme utilisée par Open-Meteo) → description FR lisible.
// Référence : https://open-meteo.com/en/docs (section "WMO Weather interpretation codes")
const WEATHER_CODE_DESCRIPTIONS: Record<number, string> = {
  0: 'Ciel dégagé',
  1: 'Principalement dégagé',
  2: 'Partiellement nuageux',
  3: 'Couvert',
  45: 'Brouillard',
  48: 'Brouillard givrant',
  51: 'Bruine légère',
  53: 'Bruine modérée',
  55: 'Bruine dense',
  61: 'Pluie légère',
  63: 'Pluie modérée',
  65: 'Pluie forte',
  71: 'Neige légère',
  73: 'Neige modérée',
  75: 'Neige forte',
  80: 'Averses légères',
  81: 'Averses modérées',
  82: 'Averses violentes',
  95: 'Orage',
  96: 'Orage avec grêle légère',
  99: 'Orage avec grêle forte',
};

@Injectable()
export class LocationWeatherService {
  /**
   * Récupère les conditions météo actuelles via Open-Meteo (gratuit, sans
   * clé API, quotas larges pour un usage MVP). Nécessite uniquement des
   * coordonnées — pas de compte ni de configuration.
   */
  async getCurrentWeather(latitude: number, longitude: number): Promise<CurrentWeather> {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', latitude.toString());
    url.searchParams.set('longitude', longitude.toString());
    url.searchParams.set(
      'current',
      'temperature_2m,precipitation,weather_code,wind_speed_10m,is_day',
    );
    url.searchParams.set('timezone', 'auto');

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Open-Meteo a échoué avec le statut ${response.status}`);
    }

    const data = await response.json();
    const current = data.current;
    if (!current) {
      throw new Error('Open-Meteo n\'a retourné aucune donnée météo actuelle.');
    }

    const weatherCode = current.weather_code;

    return {
      temperatureC: current.temperature_2m,
      precipitationMm: current.precipitation,
      windSpeedKmh: current.wind_speed_10m,
      weatherCode,
      description: WEATHER_CODE_DESCRIPTIONS[weatherCode] ?? 'Conditions inconnues',
      isDay: current.is_day === 1,
      observedAt: current.time,
    };
  }
}