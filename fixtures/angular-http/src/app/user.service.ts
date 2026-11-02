import { Injectable } from '@angular/core';
import { HttpClient as Http } from '@angular/common/http';

@Injectable({ providedIn: 'root' })
export class UserService {
  constructor(private http: Http, private cache: Map<string, string>) {}

  login(email: string) {
    return this.http.post('/api/users/login', { email });
  }

  tags() {
    // Not an HttpClient: no request.
    this.cache.get('/api/tags');
    return this.http.get('http://localhost:3000/api/tags');
  }
}
