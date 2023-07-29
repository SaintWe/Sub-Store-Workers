import { HTTP } from '../vendor/open-api';

export async function getFlowHeaders(url: string) {
    const http = HTTP({
        headers: {
            'User-Agent': 'Quantumult%20X/1.0.30 (iPhone14,2; iOS 15.6)',
        }
    });
    const { headers } = await http.get(url);
    return headers.get('SUBSCRIPTION-USERINFO');
}
