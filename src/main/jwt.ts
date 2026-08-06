import { jwtDecode } from 'jwt-decode';
import type { JwtPayload } from '../shared/types';

export function decodeJwt(token: string): JwtPayload | null {
  try {
    return jwtDecode<JwtPayload>(token);
  } catch {
    return null;
  }
}
