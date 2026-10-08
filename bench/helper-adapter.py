#!/usr/bin/env python3
"""Transport-only adapter for the byte-identical supplied Responses helper."""
import os
import runpy
import urllib.request


def install_redirect(base_url):
    original = urllib.request.urlopen

    def redirect(request, *args, **kwargs):
        if isinstance(request, urllib.request.Request) and request.full_url == 'https://api.parallel.ai/v1/responses':
            request.full_url = base_url.rstrip('/') + '/v1/responses'
        return original(request, *args, **kwargs)

    urllib.request.urlopen = redirect


if __name__ == '__main__':
    install_redirect(os.environ['PARALLEL_API_URL'])
    runpy.run_path('/opt/helper/parallel-research', run_name='__main__')
