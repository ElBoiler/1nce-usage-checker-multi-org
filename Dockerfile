FROM ruby:3.1-alpine

WORKDIR /app

# Install dependencies
COPY Gemfile ./
RUN bundle install

# Copy app
COPY app.rb ./
COPY views/ ./views/

EXPOSE 4567

CMD ["ruby", "app.rb"]
