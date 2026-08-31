import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface PlaceCandidate {
  placeId: string;
  name: string;
  formattedAddress: string;
  latitude: number | null;
  longitude: number | null;
}

export interface PlaceDetails extends PlaceCandidate {
  openingHoursText: string[] | null;
}

@Injectable()
export class LocationPlacesService {
  private readonly apiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('GOOGLE_MAPS_API_KEY') ?? '';
  }

  /**
   * Recherche des établissements par nom/adresse approximative (Places Text Search).
   * Retourne jusqu'à 5 candidats — l'utilisateur choisit ensuite lequel créer.
   */
  async searchPlaces(query: string): Promise<PlaceCandidate[]> {
    if (!this.apiKey) {
      throw new Error('GOOGLE_MAPS_API_KEY non configurée côté serveur.');
    }

    const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
    url.searchParams.set('query', query);
    url.searchParams.set('key', this.apiKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Places API a échoué avec le statut ${response.status}`);
    }

    const data = await response.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(`Places API a retourné une erreur : ${data.status}`);
    }

    return (data.results ?? []).slice(0, 5).map((result: any) => ({
      placeId: result.place_id,
      name: result.name,
      formattedAddress: result.formatted_address,
      latitude: result.geometry?.location?.lat ?? null,
      longitude: result.geometry?.location?.lng ?? null,
    }));
  }

  /**
   * Récupère le détail complet d'un établissement à partir de son place_id
   * (obtenu via searchPlaces), y compris les horaires publics si disponibles.
   */
  async getPlaceDetails(placeId: string): Promise<PlaceDetails> {
    if (!this.apiKey) {
      throw new Error('GOOGLE_MAPS_API_KEY non configurée côté serveur.');
    }

    const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
    url.searchParams.set('place_id', placeId);
    url.searchParams.set('fields', 'name,formatted_address,geometry,opening_hours');
    url.searchParams.set('key', this.apiKey);

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Places API (details) a échoué avec le statut ${response.status}`);
    }

    const data = await response.json();
    if (data.status !== 'OK') {
      throw new Error(`Places API (details) a retourné une erreur : ${data.status}`);
    }

    const result = data.result;
    return {
      placeId,
      name: result.name,
      formattedAddress: result.formatted_address,
      latitude: result.geometry?.location?.lat ?? null,
      longitude: result.geometry?.location?.lng ?? null,
      openingHoursText: result.opening_hours?.weekday_text ?? null,
    };
  }
}