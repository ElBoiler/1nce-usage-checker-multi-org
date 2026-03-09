FROM ruby:3.1-alpine

WORKDIR /app

# Install C build tools (needed for nkf, a write_xlsx transitive dependency)
RUN apk add --no-cache build-base

# Install dependencies
COPY Gemfile ./
RUN bundle install

# Copy app
COPY app.rb ./
COPY views/ ./views/

EXPOSE 4567

CMD ["ruby", "app.rb"]
