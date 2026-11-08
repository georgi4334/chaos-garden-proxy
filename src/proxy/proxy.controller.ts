import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProxyService } from './proxy.service.js';

@Controller()
export class ProxyController {
  constructor(private readonly proxy: ProxyService) {}

  /**
   * Any method on /g/<gardenId>/<targetName> or below it. Two patterns are
   * needed because the wildcard must match at least one path segment.
   * The service parses the raw URL itself so it can forward it byte-for-byte.
   */
  @All(['g/:gardenId/:targetName', 'g/:gardenId/:targetName/*path'])
  handle(@Req() req: Request, @Res() res: Response) {
    return this.proxy.handle(req, res);
  }
}
